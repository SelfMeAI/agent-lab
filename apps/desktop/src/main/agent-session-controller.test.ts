import { mkdtemp, rm } from "node:fs/promises";
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
});
