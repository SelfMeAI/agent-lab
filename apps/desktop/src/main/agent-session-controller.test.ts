import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntimeId, RunEvent, RuntimeStatus } from "../../../../packages/contracts/src/index";
import type { HarnessAdapter } from "../../../../packages/runtime/src/index";
import { AgentSessionController } from "./agent-session-controller";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

class FakeAdapter implements HarnessAdapter {
  readonly id: AgentRuntimeId;
  readonly label = "Fake";
  private readonly listeners = new Set<(event: RunEvent) => void>();
  readonly starts: Array<{ workspace: string; resumeRef?: string }> = [];
  stopped = false;
  readonly supplements: Array<{ text: string; messageId: string }> = [];
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
  async respondApproval(): Promise<void> {}
  async stop(): Promise<void> { this.stopped = true; this.emit("status", "已停止", "idle"); }
  complete(): void { this.emit("status", "完成", "ready"); }
  private emit(kind: RunEvent["kind"], text: string, phase?: RunEvent["phase"]): void {
    const event: RunEvent = { runtimeId: this.id, runId: "run", sequence: ++this.sequence, at: new Date().toISOString(), source: this.label, kind, text, phase };
    for (const listener of this.listeners) listener(event);
  }
}

describe("non-parallel multi-session lifecycle", () => {
  it("uses native steer on the existing run and rejects late input without starting a new turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-controller-steer-"));
    roots.push(root);
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

  it("does not resume an empty Codex thread before its first turn creates a rollout", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-controller-codex-empty-"));
    roots.push(root);
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

    const session = await controller.create("codex", root);
    await controller.activate(session.id);
    expect(repository.get(session.id).nativeRef).toBeNull();
    await controller.stopRuntime("codex");

    // Older builds saved this id immediately, although Codex had no rollout yet.
    repository.setNativeRef(session.id, "old-empty-thread");
    await controller.activate(session.id);
    expect(adapters[1].starts[0].resumeRef).toBeUndefined();
    await controller.send(session.id, "第一轮任务");
    expect(repository.get(session.id).nativeRef).toBe(`native-${session.id}`);
    adapters[1].complete();
    await controller.stopRuntime("codex");
    await controller.activate(session.id);
    expect(adapters[2].starts[0].resumeRef).toBe(`native-${session.id}`);

    await controller.stopAll();
    repository.close();
  });

  it("preserves the old session, blocks a new one mid-turn, and resumes its native context", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-controller-"));
    roots.push(root);
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
    await expect(controller.create("pi", root)).rejects.toThrow("仍在运行");
    adapters.get(first.id)![0].complete();
    const second = await controller.create("pi", root);
    expect(adapters.get(first.id)![0].stopped).toBe(true);
    await controller.activate(second.id);
    await controller.send(second.id, "第二项任务");
    adapters.get(second.id)![0].complete();
    await controller.activate(first.id);
    expect(adapters.get(first.id)![1].starts[0].resumeRef).toBe(`native-${first.id}`);
    expect(controller.catalog("pi").sessions.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(controller.events(first.id).some((entry) => entry.kind === "user" && entry.text === "第一项任务")).toBe(true);
    expect(controller.events(second.id).some((entry) => entry.kind === "user" && entry.text === "第二项任务")).toBe(true);
    await controller.stopAll();
    repository.close();
  });

  it("serializes rapid activation and sending so one runtime cannot run two sessions by accident", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-controller-race-"));
    roots.push(root);
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
    const secondActivation = controller.activate(second.id);
    await Promise.resolve();
    expect(adapters.has(second.id)).toBe(false);
    releaseStart();
    await Promise.all([firstActivation, secondActivation]);
    expect(adapters.get(first.id)?.stopped).toBe(true);
    expect(adapters.get(second.id)?.stopped).toBe(false);
    await controller.send(second.id, "正在执行");
    await expect(controller.activate(first.id)).rejects.toThrow("仍在运行");
    await expect(controller.create("pi", root)).rejects.toThrow("仍在运行");
    adapters.get(second.id)!.complete();
    await controller.select(first.id);
    expect(controller.catalog("pi").selectedSessionId).toBe(first.id);
    await controller.stopAll();
    repository.close();
  });

  it("blocks deletion while running, restores a deleted session, and only purges its own native home", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-controller-delete-"));
    roots.push(root);
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
    }, () => {}, false, nativeRoot);
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

  it("clears selection for the last deleted session and rejects symlinked runtime roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-controller-delete-safe-"));
    roots.push(root);
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
      (runtimeId, sessionId) => new FakeAdapter(runtimeId, sessionId), () => {}, false, nativeRoot);
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
