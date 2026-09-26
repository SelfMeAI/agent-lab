import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeId, RunEvent, RuntimeStatus } from "../../../../packages/contracts/src/index";
import type { HarnessAdapter } from "../../../../packages/runtime/src/index";
import { AgentSessionController } from "./agent-session-controller";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

const roots: string[] = [];
async function testRoot(prefix: string): Promise<string> {
  await mkdir(join(process.cwd(), ".work"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".work", prefix));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

class FakeAdapter implements HarnessAdapter {
  readonly id: AgentRuntimeId;
  readonly label = "Fake";
  private readonly listeners = new Set<(event: RunEvent) => void>();
  readonly starts: Array<{ workspace: string; resumeRef?: string }> = [];
  stopped = false;
  readonly supplements: Array<{ text: string; messageId: string }> = [];
  readonly approvals: Array<{ requestId: string | number; optionId: string }> = [];
  private sequence = 0;

  constructor(id: AgentRuntimeId, private readonly sessionId: string, private readonly startGate?: Promise<void>) { this.id = id; }
  probe(): Promise<RuntimeStatus> { return Promise.resolve({ id: this.id, label: this.label, availability: "ready" }); }
  onEvent(listener: (event: RunEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getResumeRef(): string { return `native-${this.sessionId}`; }
  async start(workspace: string, resumeRef?: string): Promise<void> {
    this.starts.push({ workspace, resumeRef });
    this.emit("status", "连接中", "starting");
    await this.startGate;
    this.emit("status", "已就绪", "ready");
  }
  async send(): Promise<void> { this.emit("status", "工作中", "running"); }
  async steer(text: string, messageId: string): Promise<void> { this.supplements.push({ text, messageId }); }
  async cancel(): Promise<void> { this.emit("status", "已就绪", "ready"); }
  async respondApproval(requestId: string | number, optionId: string): Promise<void> {
    this.approvals.push({ requestId, optionId }); this.emit("status", "已批准", "running");
  }
  async stop(): Promise<void> { this.stopped = true; this.emit("status", "已停止", "idle"); }
  complete(): void { this.emit("status", "完成", "ready"); }
  awaitApproval(): void { this.emit("approval", "需要确认", "approval"); }
  private emit(kind: RunEvent["kind"], text: string, phase?: RunEvent["phase"]): void {
    const event: RunEvent = { runtimeId: this.id, runId: "run", sequence: ++this.sequence, at: new Date().toISOString(), source: this.label, kind, text, phase };
    for (const listener of this.listeners) listener(event);
  }
}

describe("parallel multi-session lifecycle", () => {
  it("uses native steer on the existing run and rejects late input without starting a new turn", async () => {
    const root = await testRoot("controller-steer-");
    const repository = new AgentSessionRepository(root);
    await repository.init();
    const config = new AppConfigStore(root);
    await config.init();
    const adapters: FakeAdapter[] = [];
    const controller = new AgentSessionController(repository, config, (runtimeId, sessionId) => {
      const adapter = new FakeAdapter(runtimeId, sessionId); adapters.push(adapter); return adapter;
    }, () => {});
    const session = await controller.create("pi", root);
    await controller.send(session.id, "原任务");
    await controller.steer(session.id, "新增要求");
    expect(adapters).toHaveLength(1);
    expect(adapters[0].starts).toHaveLength(1);
    expect(adapters[0].supplements).toHaveLength(1);
    expect(repository.get(session.id).phase).toBe("running");
    expect(repository.events(session.id).find(e => e.deliveryMode === "steer")).toMatchObject({ kind: "user", text: "新增要求", runId: "run" });
    adapters[0].complete();
    await expect(controller.steer(session.id, "太晚了")).rejects.toThrow(/结束/);
    expect(adapters[0].supplements).toHaveLength(1);
    expect(adapters[0].starts).toHaveLength(1);
    await controller.stopAll(); repository.close();
  });

  it.each(["codex", "qwen-code"] as const)("does not resume an empty %s session before its first input persists native history", async runtimeId => {
    const root = await testRoot("controller-codex-empty-");
    const repository = new AgentSessionRepository(root);
    await repository.init();
    const config = new AppConfigStore(root);
    await config.init();
    const adapters: FakeAdapter[] = [];
    const controller = new AgentSessionController(repository, config, (runtimeId, sessionId) => {
      const adapter = new FakeAdapter(runtimeId, sessionId);
      adapters.push(adapter);
      return adapter;
    }, () => {});

    const session = await controller.create(runtimeId, root);
    await controller.activate(session.id);
    expect(repository.get(session.id).nativeRef).toBeNull();
    await controller.stopRuntime(runtimeId);

    // Older builds saved this id immediately, although Codex had no rollout yet.
    repository.setNativeRef(session.id, "old-empty-thread");
    await controller.activate(session.id);
    expect(adapters[1].starts[0].resumeRef).toBeUndefined();
    await controller.send(session.id, "第一轮任务");
    expect(repository.get(session.id).nativeRef).toBe(`native-${session.id}`);
    adapters[1].complete();
    await controller.stopRuntime(runtimeId);
    await controller.activate(session.id);
    expect(adapters[2].starts[0].resumeRef).toBe(`native-${session.id}`);

    await controller.stopAll();
    repository.close();
  });

  it("keeps both sessions running, preserves selection and resumes each native context after restart", async () => {
    const root = await testRoot("controller-parallel-");
    const repository = new AgentSessionRepository(root);
    await repository.init();
    const config = new AppConfigStore(root);
    await config.init();
    const adapters = new Map<string, FakeAdapter[]>();
    const controller = new AgentSessionController(repository, config, (runtimeId, sessionId) => {
      const adapter = new FakeAdapter(runtimeId, sessionId);
      adapters.set(sessionId, [...(adapters.get(sessionId) ?? []), adapter]);
      return adapter;
    }, () => {});

    const first = await controller.create("pi", root);
    await controller.activate(first.id);
    await controller.send(first.id, "第一项任务");
    const second = await controller.create("pi", root);
    expect(adapters.get(first.id)![0].stopped).toBe(false);
    await controller.activate(second.id);
    await controller.send(second.id, "第二项任务");
    expect(repository.get(first.id).phase).toBe("running");
    expect(repository.get(second.id).phase).toBe("running");
    await controller.select(first.id);
    await controller.activate(first.id);
    expect(adapters.get(first.id)).toHaveLength(1);
    expect(adapters.get(second.id)![0].stopped).toBe(false);
    await controller.cancel(first.id);
    expect(repository.get(second.id).phase).toBe("running");
    expect(controller.isBusy("pi")).toBe(true);
    adapters.get(second.id)![0].complete();
    await controller.stopRuntime("pi");
    await controller.activate(first.id);
    await controller.activate(second.id);
    expect(adapters.get(first.id)![1].starts[0].resumeRef).toBe(`native-${first.id}`);
    expect(adapters.get(second.id)![1].starts[0].resumeRef).toBe(`native-${second.id}`);
    expect(controller.catalog("pi").selectedSessionId).toBe(first.id);
    expect(controller.catalog("pi").sessions.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(controller.events(first.id).some((entry) => entry.kind === "user" && entry.text === "第一项任务")).toBe(true);
    expect(controller.events(second.id).some((entry) => entry.kind === "user" && entry.text === "第二项任务")).toBe(true);
    await controller.stopAll();
    repository.close();
  });

  it("serializes each session, but a slow start does not block another session or hijack selection", async () => {
    const root = await testRoot("controller-race-");
    const repository = new AgentSessionRepository(root);
    await repository.init();
    const config = new AppConfigStore(root);
    await config.init();
    const adapters = new Map<string, FakeAdapter>();
    let releaseStart = (): void => {};
    const gate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const controller = new AgentSessionController(repository, config, (runtimeId, sessionId) => {
      const adapter = new FakeAdapter(runtimeId, sessionId, adapters.size === 0 ? gate : undefined);
      adapters.set(sessionId, adapter);
      return adapter;
    }, () => {});
    const first = await controller.create("pi", root);
    const second = await controller.create("pi", root);
    const firstActivation = controller.activate(first.id);
    const duplicateActivation = controller.activate(first.id);
    const secondActivation = controller.activate(second.id);
    await secondActivation;
    await controller.send(second.id, "正在执行");
    await controller.select(second.id);
    expect(adapters.has(second.id)).toBe(true);
    expect(repository.get(first.id).phase).toBe("starting");
    expect(repository.get(second.id).phase).toBe("running");
    releaseStart();
    await Promise.all([firstActivation, duplicateActivation]);
    expect(adapters.get(first.id)?.starts).toHaveLength(1);
    expect(adapters.get(first.id)?.stopped).toBe(false);
    expect(adapters.get(second.id)?.stopped).toBe(false);
    expect(controller.catalog("pi").selectedSessionId).toBe(second.id);
    await controller.send(first.id, "也正在执行");
    await expect(controller.send(first.id, "不能重复开轮次")).rejects.toThrow("上一轮");
    await controller.select(first.id);
    expect(controller.catalog("pi").selectedSessionId).toBe(first.id);
    await controller.stopAll();
    repository.close();
  });

  it("blocks deletion while running, restores a deleted session, and only purges its own native home", async () => {
    const root = await testRoot("controller-delete-");
    const repository = new AgentSessionRepository(root);
    await repository.init();
    const config = new AppConfigStore(root);
    await config.init();
    const nativeRoot = join(root, "runtime-homes");
    const adapters = new Map<string, FakeAdapter>();
    const controller = new AgentSessionController(repository, config, (runtimeId, sessionId) => {
      const adapter = new FakeAdapter(runtimeId, sessionId);
      adapters.set(sessionId, adapter);
      return adapter;
    }, () => {}, nativeRoot);
    const first = await controller.create("pi", root);
    await controller.activate(first.id);
    await controller.send(first.id, "keep working");
    await expect(controller.delete(first.id)).rejects.toThrow("仍在运行");
    adapters.get(first.id)!.complete();
    const second = await controller.create("pi", root);
    await controller.activate(second.id);
    const home = join(nativeRoot, "pi", second.id);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "native-session"), "keep until purge");
    await writeFile(join(root, "user-workspace-file"), "never delete workspace");
    await controller.delete(second.id);
    expect(controller.catalog("pi").selectedSessionId).toBe(first.id);
    expect(controller.catalog("pi").deletedSessions.map((item) => item.id)).toEqual([second.id]);
    await access(join(home, "native-session"));
    await controller.restore(second.id);
    expect(controller.catalog("pi").sessions.some((item) => item.id === second.id)).toBe(true);
    await controller.delete(second.id);
    await controller.purge(second.id);
    expect(controller.catalog("pi").deletedSessions).toEqual([]);
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
    await access(join(root, "user-workspace-file"));
    await controller.stopAll();
    repository.close();
  });

  it("routes colliding native approval ids and cancellation locks to the target session only", async () => {
    const root = await testRoot("controller-controls-");
    const repository = new AgentSessionRepository(root); await repository.init();
    const config = new AppConfigStore(root); await config.init();
    const adapters = new Map<string, FakeAdapter>();
    const controller = new AgentSessionController(repository, config, (runtimeId, id) => {
      const adapter = new FakeAdapter(runtimeId, id); adapters.set(id, adapter); return adapter;
    }, () => {});
    const a = await controller.create("pi", root), b = await controller.create("pi", root);
    await Promise.all([controller.send(a.id, "A"), controller.send(b.id, "B")]);
    const first = adapters.get(a.id)!, second = adapters.get(b.id)!;
    first.awaitApproval(); second.awaitApproval();
    await controller.respondApproval(a.id, 1, "allow");
    expect(first.approvals).toEqual([{ requestId: 1, optionId: "allow" }]);
    expect(second.approvals).toEqual([]);
    expect(repository.get(b.id).phase).toBe("approval");
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let cancellations = 0;
    first.cancel = async () => { cancellations++; await gate; first.complete(); };
    const cancelled = controller.cancel(a.id), duplicate = controller.cancel(a.id);
    await expect(controller.steer(a.id, "不能提交")).rejects.toThrow("停止");
    await controller.steer(b.id, "B 仍可补充");
    await controller.respondApproval(b.id, 1, "allow");
    expect(second.approvals).toEqual([{ requestId: 1, optionId: "allow" }]);
    expect(second.supplements[0].text).toBe("B 仍可补充");
    release(); await Promise.all([cancelled, duplicate]);
    expect(cancellations).toBe(1);
    expect(repository.get(b.id).phase).toBe("running");
    await controller.stopAll(); repository.close();
  });

  it("settles a connection before runtime shutdown and prevents late work from reopening it", async () => {
    const root = await testRoot("controller-shutdown-");
    const repository = new AgentSessionRepository(root); await repository.init();
    const config = new AppConfigStore(root); await config.init();
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const adapters: FakeAdapter[] = [];
    const controller = new AgentSessionController(repository, config, (runtimeId, id) => {
      const adapter = new FakeAdapter(runtimeId, id, adapters.length ? undefined : gate); adapters.push(adapter); return adapter;
    }, () => {});
    const a = await controller.create("pi", root), b = await controller.create("pi", root);
    const activating = controller.activate(a.id);
    await Promise.resolve(); await Promise.resolve();
    expect(controller.isBusy("pi")).toBe(true);
    const stopping = controller.stopRuntime("pi");
    await expect(controller.activate(b.id)).rejects.toThrow("关闭");
    await expect(controller.create("pi", root)).rejects.toThrow("关闭");
    release(); await activating; await stopping;
    expect(adapters).toHaveLength(1); expect(adapters[0].stopped).toBe(true);
    await controller.activate(b.id);
    expect(adapters).toHaveLength(2);
    await controller.stopAll();
    await expect(controller.activate(a.id)).rejects.toThrow("关闭");
    repository.close();
  });

  it("protects shared provider edits across all sessions without blocking another harness", async () => {
    const root = await testRoot("controller-provider-");
    const repository = new AgentSessionRepository(root); await repository.init();
    const config = new AppConfigStore(root); await config.init();
    const adapters = new Map<string, FakeAdapter>();
    const controller = new AgentSessionController(repository, config, (runtimeId, id) => {
      const adapter = new FakeAdapter(runtimeId, id); adapters.set(id, adapter); return adapter;
    }, () => {});
    const a = await controller.create("pi", root), b = await controller.create("pi", root);
    await controller.send(a.id, "后台任务");
    await controller.activate(b.id);
    let saved = false;
    await expect(controller.reconfigure("pi", async () => { saved = true; })).rejects.toThrow("会话在运行");
    expect(saved).toBe(false);
    adapters.get(a.id)!.complete();
    await vi.waitFor(() => expect(controller.isBusy("pi")).toBe(false));
    let release = (): void => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const updating = controller.reconfigure("pi", async () => { await gate; return "saved"; });
    await expect(controller.send(b.id, "不能读取新旧混合配置")).rejects.toThrow("关闭");
    const dsh = await controller.create("dsh", root);
    await controller.send(dsh.id, "另一个 Harness 不受影响");
    release(); expect(await updating).toBe("saved");
    expect(adapters.get(a.id)!.stopped).toBe(true);
    expect(adapters.get(b.id)!.stopped).toBe(true);
    expect(adapters.get(dsh.id)!.stopped).toBe(false);
    await expect(controller.reconfigure("pi", async () => { throw new Error("save failed"); })).rejects.toThrow("save failed");
    await controller.activate(b.id);
    await controller.stopAll(); repository.close();
  });

  it("clears selection for the last deleted session and rejects symlinked runtime roots", async () => {
    const root = await testRoot("controller-delete-safe-");
    const repository = new AgentSessionRepository(root);
    await repository.init();
    const config = new AppConfigStore(root);
    await config.init();
    const nativeRoot = join(root, "runtime-homes");
    const outside = join(root, "unrelated-user-files");
    await mkdir(nativeRoot);
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, join(nativeRoot, "pi"));
    const controller = new AgentSessionController(repository, config,
      (runtimeId, sessionId) => new FakeAdapter(runtimeId, sessionId), () => {}, nativeRoot);
    const only = await controller.create("pi", root);
    await controller.delete(only.id);
    expect(controller.catalog("pi")).toMatchObject({ selectedSessionId: null, sessions: [] });
    await controller.restore(only.id);
    expect(controller.catalog("pi").selectedSessionId).toBe(only.id);
    await controller.delete(only.id);
    await expect(controller.purge(only.id)).rejects.toThrow("符号链接");
    expect(controller.catalog("pi").deletedSessions).toHaveLength(1);
    await access(join(outside, "keep.txt"));
    repository.close();
  });
});
