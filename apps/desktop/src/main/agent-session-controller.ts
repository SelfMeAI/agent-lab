import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AgentRuntimeId, AgentSessionCatalog, AgentSessionEvent, AgentSessionSummary, AgentSessionQueue, PendingAgentMessage, RunEvent, RuntimePhase } from "../../../../packages/contracts/src/index";
import type { HarnessAdapter } from "../../../../packages/runtime/src/index";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

type LiveSession = { adapter: HarnessAdapter; unsubscribe: () => void; runId?: string };
type AdapterFactory = (runtimeId: AgentRuntimeId, sessionId: string) => HarnessAdapter;

const busyPhases = new Set<RuntimePhase>(["starting", "running", "approval", "cancelling"]);

/** Owns app sessions independently of each harness's native session identity. */
export class AgentSessionController {
  private readonly live = new Map<string, LiveSession>();
  private readonly operations = new Map<AgentRuntimeId, Promise<void>>();
  private readonly draining = new Set<string>();
  private readonly cancellations = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: AgentSessionRepository,
    private readonly config: AppConfigStore,
    private readonly createAdapter: AdapterFactory,
    private readonly emit: (event: AgentSessionEvent) => void,
    private readonly allowParallel = false,
    private readonly runtimeHomesRoot?: string,
    private readonly emitQueue: (id: string, queue: AgentSessionQueue) => void = () => {},
  ) {}

  catalog(runtimeId: AgentRuntimeId): AgentSessionCatalog {
    const sessions = this.repository.list(runtimeId);
    const preference = this.config.get(runtimeId);
    return {
      sessions,
      deletedSessions: this.repository.listDeleted(runtimeId),
      selectedSessionId: sessions.some((item) => item.id === preference.selectedSessionId)
        ? preference.selectedSessionId : sessions[0]?.id ?? null,
      lastWorkspace: preference.lastWorkspace,
      queues: Object.fromEntries(sessions.map((item) => [item.id, this.repository.queue(item.id)])),
    };
  }

  events(id: string): AgentSessionEvent[] { return this.repository.events(id); }

  async create(runtimeId: AgentRuntimeId, workspace: string): Promise<AgentSessionSummary> {
    const canonical = await realpath(workspace);
    if (!(await stat(canonical)).isDirectory()) throw new Error("工作目录必须是文件夹");
    return this.serial(runtimeId, async () => {
      if (!this.allowParallel) await this.stopOtherSessions(runtimeId);
      const session = this.repository.create(runtimeId, canonical);
      await this.config.select(runtimeId, session.id, canonical);
      return session;
    });
  }

  async activate(id: string): Promise<void> {
    const runtimeId = this.repository.get(id).runtimeId;
    await this.serial(runtimeId, () => this.start(id));
  }

  async select(id: string): Promise<void> {
    const record = this.repository.get(id);
    await this.serial(record.runtimeId, () => this.config.select(record.runtimeId, id, record.workspace));
  }

  async delete(id: string): Promise<void> {
    const runtimeId = this.repository.get(id).runtimeId;
    await this.serial(runtimeId, async () => {
      const record = this.repository.get(id);
      if (busyPhases.has(record.phase)) throw new Error("会话仍在运行，请先完成或取消任务");
      await this.stop(id);
      this.repository.softDelete(id);
      if (this.config.get(runtimeId).selectedSessionId === id) {
        const fallback = this.repository.list(runtimeId)[0];
        if (fallback) await this.config.select(runtimeId, fallback.id, fallback.workspace);
        else await this.config.clearSelection(runtimeId);
      }
    });
  }

  async restore(id: string): Promise<void> {
    const runtimeId = this.repository.get(id, true).runtimeId;
    await this.serial(runtimeId, async () => {
      const restored = this.repository.restore(id);
      if (!this.config.get(runtimeId).selectedSessionId) {
        await this.config.select(runtimeId, restored.id, restored.workspace);
      }
    });
  }

  async purge(id: string): Promise<void> {
    const runtimeId = this.repository.get(id, true).runtimeId;
    await this.serial(runtimeId, async () => {
      const record = this.repository.get(id, true);
      if (!record.deletedAt) throw new Error("请先将会话移至最近删除");
      if (this.live.has(id)) throw new Error("会话仍在运行，不能彻底删除");
      let staged: string | null = null;
      let home: string | null = null;
      if (this.runtimeHomesRoot) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("会话标识无效，不能清理运行目录");
        const runtimeRoot = resolve(this.runtimeHomesRoot, record.runtimeId);
        home = resolve(runtimeRoot, id);
        if (!home.startsWith(runtimeRoot + sep)) throw new Error("运行目录不在受控范围内");
        for (const parent of [this.runtimeHomesRoot, runtimeRoot]) {
          try {
            if ((await lstat(parent)).isSymbolicLink()) throw new Error("运行目录包含符号链接，不能自动清理");
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        const stagingRoot = resolve(this.runtimeHomesRoot, ".deleting");
        await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
        const target = join(stagingRoot, `${id}-${randomUUID()}`);
        try { await rename(home, target); staged = target; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      try { this.repository.purge(id); }
      catch (error) {
        if (staged && home) await rename(staged, home);
        throw error;
      }
      if (staged) await rm(staged, { recursive: true, force: true });
    });
  }

  private async start(id: string): Promise<void> {
    const record = this.repository.get(id);
    if (this.live.has(id) && (record.phase === "error" || record.phase === "idle")) await this.stop(id);
    if (!this.live.has(id)) {
      if (!this.allowParallel) await this.stopOtherSessions(record.runtimeId);
      const adapter = this.createAdapter(record.runtimeId, id);
      const unsubscribe = adapter.onEvent((event) => this.forward(id, event));
      this.live.set(id, { adapter, unsubscribe });
      try {
        // Codex does not write a resumable rollout until the first turn starts.
        // An empty thread may have an id but thread/resume cannot load it later.
        const resumeRef = record.runtimeId === "codex" && record.lastPromptAt === null
          ? undefined : record.nativeRef ?? undefined;
        await adapter.start(record.workspace, resumeRef);
        const nativeRef = adapter.getResumeRef();
        if (!nativeRef) throw new Error("运行时未返回可恢复的会话标识");
        if (record.runtimeId !== "codex") this.repository.setNativeRef(id, nativeRef);
      } catch (error) {
        await this.stop(id);
        throw error;
      }
    }
    await this.config.select(record.runtimeId, id, record.workspace);
  }

  async send(id: string, prompt: string): Promise<void> {
    this.assertNotStopping(id);
    const text = this.promptText(prompt);
    const runtimeId = this.repository.get(id).runtimeId;
    await this.serial(runtimeId, () => {
      if (this.repository.queue(id).messages.some((item) => item.state !== "awaiting")) throw new Error("已有待发送消息，请先处理或继续队列");
      return this.dispatchPrompt(id, text);
    });
  }

  private async dispatchPrompt(id: string, text: string, pending?: PendingAgentMessage): Promise<void> {
    const runtimeId = this.repository.get(id).runtimeId;
    try {
      await this.start(id);
      this.assertNotStopping(id);
      const record = this.repository.get(id);
      if (record.phase !== "ready") throw new Error("当前会话尚未就绪，或仍在执行上一轮任务");
      if (!this.repository.queue(id).messages.length) this.repository.pauseQueue(id, false);
      if (pending) {
        this.repository.updateQueueMessage(id, pending.id, { state: "sending", mode: "queue", detail: undefined });
        this.queueChanged(id);
      }
      this.forward(id, {
        runtimeId, runId: randomUUID(), sequence: 0, at: new Date().toISOString(),
        source: "SelfMe Lab", kind: "user", text,
        ...(pending ? { messageId: pending.id, deliveryMode: "queue" as const, deliveryState: "submitting" as const } : {}),
      });
      const adapter = this.live.get(id)!.adapter;
      await adapter.send(text);
      if (runtimeId === "codex") {
        const nativeRef = adapter.getResumeRef();
        if (!nativeRef) throw new Error("Codex 首轮任务未返回可恢复的会话标识");
        this.repository.setNativeRef(id, nativeRef);
      }
      if (pending) {
        this.forward(id, { runtimeId, runId: this.live.get(id)?.runId ?? "session", sequence: 0, at: new Date().toISOString(),
          source: "SelfMe Lab", kind: "delivery", messageId: pending.id, deliveryState: "incorporated" });
      }
    } catch (error) {
      if (pending && this.repository.queueMessage(id, pending.id)) {
        const hasUserEvent = this.repository.events(id).some((event) => event.kind === "user" && event.messageId === pending.id);
        // Before native submission the entry is still safely unsent. Once a
        // send was attempted, leave the outcome explicit instead of replaying.
        this.repository.updateQueueMessage(id, pending.id, { state: hasUserEvent ? "unconfirmed" : "queued", detail: "发送未确认，请查看对话后决定是否重发" });
        this.repository.pauseQueue(id, true);
        if (hasUserEvent) this.forward(id, { runtimeId, runId: this.live.get(id)?.runId ?? "session", sequence: 0, at: new Date().toISOString(),
          source: "SelfMe Lab", kind: "delivery", messageId: pending.id, deliveryState: "unconfirmed", text: "发送未确认，请查看对话后决定是否重发" });
        else this.queueChanged(id);
      }
      throw error;
    }
  }

  async cancel(id: string): Promise<void> {
    const existing = this.cancellations.get(id);
    if (existing) return existing;
    const live = this.live.get(id);
    if (!live) throw new Error("会话未在运行");
    // Lock immediately, before a harness acknowledges cancellation or emits
    // its cancelling phase. A second click shares this request, not a new one.
    const cancellation = Promise.resolve().then(() => live.adapter.cancel());
    this.cancellations.set(id, cancellation);
    try {
      this.repository.pauseQueue(id, true);
      this.queueChanged(id);
      await cancellation;
    } finally {
      if (this.cancellations.get(id) === cancellation) this.cancellations.delete(id);
    }
  }

  async steer(id: string, prompt: string): Promise<void> {
    this.assertNotStopping(id);
    const text = this.promptText(prompt);
    const runtimeId = this.repository.get(id).runtimeId;
    await this.serial(runtimeId, () => this.submitSteer(id, text));
  }

  private async submitSteer(id: string, text: string, pending?: PendingAgentMessage): Promise<void> {
      this.assertNotStopping(id);
      const live = this.live.get(id);
      const record = this.repository.get(id);
      // Explicit steering never falls back to start()/send() after a finish race.
      if (!live || !["running", "approval"].includes(record.phase)) throw new Error("本轮已结束或正在取消，补充指令未提交");
      const messageId = pending?.id ?? randomUUID();
      if (pending) this.repository.updateQueueMessage(id, messageId, { state: "sending", mode: "steer", detail: undefined });
      else this.repository.addQueueMessage(id, { id: messageId, text, createdAt: new Date().toISOString(), mode: "steer", state: "sending" });
      this.queueChanged(id);
      const base = { runtimeId: record.runtimeId, runId: live.runId ?? "session", sequence: 0, at: new Date().toISOString(), source: "SelfMe Lab", messageId };
      this.forward(id, { ...base, kind: "user", text, deliveryMode: "steer", deliveryState: "submitting" });
      try { await live.adapter.steer(text, messageId); }
      catch (error) {
        // Adapter receipts already report transport uncertainty; fill only failures
        // occurring before native admission (e.g. queue limit/turn finished race).
        const receipt = this.repository.events(id).some((event) => event.kind === "delivery" && event.messageId === messageId);
        if (!receipt) this.forward(id, { ...base, at: new Date().toISOString(), kind: "delivery", deliveryState: "rejected", text: error instanceof Error ? error.message : String(error) });
        // The saved entry is the recovery surface; don't also restore the
        // composer draft and accidentally submit it twice.
        return;
      }
  }

  async enqueue(id: string, prompt: string): Promise<void> {
    const text = this.promptText(prompt), runtimeId = this.repository.get(id).runtimeId;
    await this.serial(runtimeId, async () => {
      const phase = this.repository.get(id).phase;
      this.repository.addQueueMessage(id, { id: randomUUID(), text, createdAt: new Date().toISOString(), mode: "queue", state: "queued" });
      if (["cancelling", "error", "idle"].includes(phase)) this.repository.pauseQueue(id, true);
      this.queueChanged(id);
      this.scheduleDrain(id);
    });
  }

  async editQueued(id: string, messageId: string, prompt: string): Promise<void> {
    const text = this.promptText(prompt);
    await this.serial(this.repository.get(id).runtimeId, async () => {
      if (this.repository.queueMessage(id, messageId)?.state !== "queued") throw new Error("消息已提交，不能再编辑");
      this.repository.updateQueueMessage(id, messageId, { text });
      this.queueChanged(id);
    });
  }

  async deleteQueued(id: string, messageId: string): Promise<void> {
    await this.serial(this.repository.get(id).runtimeId, async () => {
      const item = this.repository.queueMessage(id, messageId);
      if (!item) return;
      if (!["queued", "unconfirmed"].includes(item.state)) throw new Error("消息已提交，不能撤回");
      this.repository.removeQueueMessage(id, messageId);
      this.queueChanged(id);
      this.scheduleDrain(id);
    });
  }

  async moveQueued(id: string, messageId: string, direction: "up" | "down"): Promise<void> {
    await this.serial(this.repository.get(id).runtimeId, async () => {
      this.repository.moveQueueMessage(id, messageId, direction);
      this.queueChanged(id);
    });
  }

  async steerQueued(id: string, messageId: string): Promise<void> {
    this.assertNotStopping(id);
    await this.serial(this.repository.get(id).runtimeId, async () => {
      const item = this.repository.queueMessage(id, messageId);
      if (!item || item.state !== "queued") throw new Error("消息已提交或已删除");
      await this.submitSteer(id, item.text, item);
    });
  }

  async retryQueued(id: string, messageId: string): Promise<void> {
    await this.serial(this.repository.get(id).runtimeId, async () => {
      this.repository.retryQueueMessage(id, messageId);
      this.queueChanged(id);
    });
  }

  async resumeQueue(id: string): Promise<void> {
    this.assertNotStopping(id);
    await this.serial(this.repository.get(id).runtimeId, async () => {
      this.assertNotStopping(id);
      if (this.repository.queue(id).messages.some((item) => item.state === "unconfirmed")) throw new Error("请先处理发送未确认的消息");
      if (!busyPhases.has(this.repository.get(id).phase)) await this.start(id);
      this.repository.pauseQueue(id, false);
      this.queueChanged(id);
      this.scheduleDrain(id);
    });
  }

  pauseQueue(id: string): void {
    this.repository.pauseQueue(id, true);
    this.queueChanged(id);
  }

  async respondApproval(id: string, requestId: string | number, optionId: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error("会话未在运行，审批已失效");
    await live.adapter.respondApproval(requestId, optionId);
  }

  isBusy(runtimeId: AgentRuntimeId): boolean {
    return [...this.live.keys()].some((id) => {
      const record = this.repository.get(id);
      return record.runtimeId === runtimeId && busyPhases.has(record.phase);
    });
  }

  async stopRuntime(runtimeId: AgentRuntimeId): Promise<void> {
    await this.serial(runtimeId, () => Promise.all([...this.live.keys()]
      .filter((id) => this.repository.get(id).runtimeId === runtimeId).map((id) => this.stop(id))).then(() => {}));
  }

  async stopAll(): Promise<void> {
    await Promise.all((["dsh", "codex", "pi", "kimi-code"] as const).map((runtimeId) => this.stopRuntime(runtimeId)));
  }

  private async serial<T>(runtimeId: AgentRuntimeId, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(runtimeId);
    const current = (previous ?? Promise.resolve()).catch(() => {}).then(action);
    const settled = current.then(() => {}, () => {});
    this.operations.set(runtimeId, settled);
    try { return await current; }
    finally { if (this.operations.get(runtimeId) === settled) this.operations.delete(runtimeId); }
  }

  private async stopOtherSessions(runtimeId: AgentRuntimeId): Promise<void> {
    for (const id of this.live.keys()) {
      const record = this.repository.get(id);
      if (record.runtimeId !== runtimeId) continue;
      if (busyPhases.has(record.phase)) throw new Error("当前任务仍在运行，请先完成或取消后切换会话");
      await this.stop(id);
    }
  }

  private async stop(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    if (this.repository.queue(id).messages.length) { this.repository.pauseQueue(id, true); this.queueChanged(id); }
    this.live.delete(id);
    try { await live.adapter.stop(); }
    finally { live.unsubscribe(); }
  }

  private forward(id: string, event: RunEvent): void {
    if (event.phase === "running") {
      const live = this.live.get(id);
      if (live) live.runId = event.runId;
    }
    this.emit(this.repository.append(id, event));
    if (event.kind === "delivery") this.queueChanged(id);
    if (event.kind === "error" || event.phase === "error" || event.phase === "cancelling") {
      this.queueChanged(id);
    }
    if (event.phase === "ready") this.scheduleDrain(id);
  }

  private promptText(prompt: string): string {
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("请输入消息内容");
    if (prompt.length > 100000) throw new Error("消息过长，请拆分后提交");
    return prompt.trim();
  }

  private queueChanged(id: string): void { this.emitQueue(id, this.repository.queue(id)); }

  private assertNotStopping(id: string): void {
    if (this.cancellations.has(id) || this.repository.get(id).phase === "cancelling") {
      throw new Error("当前轮正在停止，请稍候");
    }
  }

  private scheduleDrain(id: string): void {
    if (this.draining.has(id) || !this.live.has(id)) return;
    const runtimeId = this.repository.get(id).runtimeId;
    this.draining.add(id);
    void this.serial(runtimeId, async () => {
      if (!this.live.has(id)) return;
      const queue = this.repository.queue(id);
      if (queue.paused || this.cancellations.has(id) || this.repository.get(id).phase !== "ready") return;
      const item = queue.messages.find((message) => message.state !== "awaiting");
      if (item?.state === "queued") await this.dispatchPrompt(id, item.text, item);
    }).catch(() => {
      // Delivery/task errors are already recorded; saved work must not loop.
      if (!this.live.has(id)) return;
      this.repository.pauseQueue(id, true);
      this.queueChanged(id);
    }).finally(() => {
      this.draining.delete(id);
      if (!this.live.has(id)) return;
      const queue = this.repository.queue(id);
      if (!queue.paused && !this.cancellations.has(id) && this.repository.get(id).phase === "ready" && queue.messages.find((item) => item.state !== "awaiting")?.state === "queued") this.scheduleDrain(id);
    });
  }
}
