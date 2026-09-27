import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AgentQuestionAnswers, AgentRuntimeId, AgentSessionCatalog, AgentSessionEvent, AgentSessionSummary, AgentSessionQueue, FollowUpMode, PendingAgentMessage, RunEvent, RuntimePhase } from "../../../../packages/contracts/src/index";
import { agentRuntimeIds } from "../../../../packages/contracts/src/index";
import type { HarnessAdapter } from "../../../../packages/runtime/src/index";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

type LiveSession = { adapter: HarnessAdapter; unsubscribe: () => void; runId?: string };
type AdapterFactory = (runtimeId: AgentRuntimeId, sessionId: string) => HarnessAdapter;

const busyPhases = new Set<RuntimePhase>(["starting", "running", "approval", "cancelling"]);

/** Owns app sessions independently of each harness's native session identity. */
export class AgentSessionController {
  private readonly live = new Map<string, LiveSession>();
  private readonly operations = new Map<string, { runtimeId: AgentRuntimeId; settled: Promise<void> }>();
  private readonly stoppingRuntimes = new Map<AgentRuntimeId, Promise<void>>();
  private closing = false;
  private readonly draining = new Set<string>();
  private readonly cancellations = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: AgentSessionRepository,
    private readonly config: AppConfigStore,
    private readonly createAdapter: AdapterFactory,
    private readonly emit: (event: AgentSessionEvent) => void,
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

  setFollowUpMode(id: string, mode: FollowUpMode): void { this.repository.setFollowUpMode(id, mode); }

  async create(runtimeId: AgentRuntimeId, workspace: string): Promise<AgentSessionSummary> {
    this.assertRuntimeAvailable(runtimeId);
    const canonical = await realpath(workspace);
    if (!(await stat(canonical)).isDirectory()) throw new Error("工作目录必须是文件夹");
    this.assertRuntimeAvailable(runtimeId);
    const session = this.repository.create(runtimeId, canonical);
    await this.config.select(runtimeId, session.id, canonical);
    return session;
  }

  async activate(id: string): Promise<void> {
    await this.serial(id, () => this.start(id));
  }

  async select(id: string): Promise<void> {
    const record = this.repository.get(id);
    // Selection is a UI preference, not a runtime operation. A slow connection
    // must not delay switching, and background starts must never change it.
    this.assertRuntimeAvailable(record.runtimeId);
    await this.config.select(record.runtimeId, id, record.workspace);
  }

  async delete(id: string): Promise<void> {
    const runtimeId = this.repository.get(id).runtimeId;
    await this.serial(id, async () => {
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
    await this.serial(id, async () => {
      const restored = this.repository.restore(id);
      if (!this.config.get(runtimeId).selectedSessionId) {
        await this.config.select(runtimeId, restored.id, restored.workspace);
      }
    });
  }

  async purge(id: string): Promise<void> {
    await this.serial(id, async () => {
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
      const adapter = this.createAdapter(record.runtimeId, id);
      const unsubscribe = adapter.onEvent((event) => this.forward(id, event));
      this.live.set(id, { adapter, unsubscribe });
      try {
        // These runtimes do not persist empty sessions until the first input.
        // An allocated native id alone is not a recoverable conversation.
        const resumeRef = ["codex", "qwen-code", "claude-code"].includes(record.runtimeId) && record.lastPromptAt === null
          ? undefined : record.nativeRef ?? undefined;
        await adapter.start(record.workspace, resumeRef);
        const nativeRef = adapter.getResumeRef();
        if (!nativeRef) throw new Error("运行时未返回可恢复的会话标识");
        if (!["codex", "qwen-code", "claude-code"].includes(record.runtimeId)) this.repository.setNativeRef(id, nativeRef);
      } catch (error) {
        await this.stop(id);
        throw error;
      }
    }
  }

  async send(id: string, prompt: string): Promise<void> {
    this.assertNotStopping(id);
    const text = this.promptText(prompt);
    await this.serial(id, () => {
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
      if (["codex", "qwen-code", "claude-code"].includes(runtimeId)) {
        const nativeRef = adapter.getResumeRef();
        if (!nativeRef) throw new Error(`${adapter.label} 首轮任务未返回可恢复的会话标识`);
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
    await this.serial(id, () => this.submitSteer(id, text));
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
    const text = this.promptText(prompt);
    await this.serial(id, async () => {
      const phase = this.repository.get(id).phase;
      this.repository.addQueueMessage(id, { id: randomUUID(), text, createdAt: new Date().toISOString(), mode: "queue", state: "queued" });
      if (["cancelling", "error", "idle"].includes(phase)) this.repository.pauseQueue(id, true);
      this.queueChanged(id);
      this.scheduleDrain(id);
    });
  }

  async editQueued(id: string, messageId: string, prompt: string): Promise<void> {
    const text = this.promptText(prompt);
    await this.serial(id, async () => {
      if (this.repository.queueMessage(id, messageId)?.state !== "queued") throw new Error("消息已提交，不能再编辑");
      this.repository.updateQueueMessage(id, messageId, { text });
      this.queueChanged(id);
    });
  }

  async deleteQueued(id: string, messageId: string): Promise<void> {
    await this.serial(id, async () => {
      const item = this.repository.queueMessage(id, messageId);
      if (!item) return;
      if (!["queued", "unconfirmed"].includes(item.state)) throw new Error("消息已提交，不能撤回");
      this.repository.removeQueueMessage(id, messageId);
      this.queueChanged(id);
      this.scheduleDrain(id);
    });
  }

  async moveQueued(id: string, messageId: string, direction: "up" | "down"): Promise<void> {
    await this.serial(id, async () => {
      this.repository.moveQueueMessage(id, messageId, direction);
      this.queueChanged(id);
    });
  }

  async steerQueued(id: string, messageId: string): Promise<void> {
    this.assertNotStopping(id);
    await this.serial(id, async () => {
      const item = this.repository.queueMessage(id, messageId);
      if (!item || item.state !== "queued") throw new Error("消息已提交或已删除");
      await this.submitSteer(id, item.text, item);
    });
  }

  async retryQueued(id: string, messageId: string): Promise<void> {
    await this.serial(id, async () => {
      this.repository.retryQueueMessage(id, messageId);
      this.queueChanged(id);
    });
  }

  async resumeQueue(id: string): Promise<void> {
    this.assertNotStopping(id);
    await this.serial(id, async () => {
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

  async respondApproval(id: string, requestId: string | number, optionId: string, answers?: AgentQuestionAnswers): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error("会话未在运行，审批已失效");
    const request = this.repository.events(id).reverse().find(event => event.kind === "approval" && event.approval?.requestId === requestId && event.runId === live.runId);
    const decision = request?.approval?.options.find(option => option.optionId === optionId);
    if (!request?.approval || !decision) throw new Error("审批已失效或选项无效");
    await live.adapter.respondApproval(requestId, optionId, answers);
    if (request?.approval) {
      const questions = request.approval.questions;
      const submitted = request.approval.options.find(option => option.optionId === optionId)?.kind.includes("allow") && answers;
      const text = questions !== undefined
        ? submitted ? questions.map(q => `${q.header || q.question}：${q.secret ? "已填写（隐藏内容）" : (submitted[q.id] ?? []).join("、")}`).join("\n") : "已取消回答"
        : undefined;
      this.forward(id, { runtimeId: request.runtimeId, source: request.source, runId: request.runId,
        sequence: request.sequence, at: new Date().toISOString(), kind: "approval_result", title: "你的回答", text,
        approval: request.approval, approvalDecision: decision, approvalDecisionSource: "user" });
    }
  }

  isBusy(runtimeId: AgentRuntimeId): boolean {
    return this.stoppingRuntimes.has(runtimeId) || [...this.operations.values()].some(op => op.runtimeId === runtimeId) || [...this.live.keys()].some((id) => {
      const record = this.repository.get(id);
      return record.runtimeId === runtimeId && busyPhases.has(record.phase);
    });
  }

  async stopRuntime(runtimeId: AgentRuntimeId): Promise<void> {
    const existing = this.stoppingRuntimes.get(runtimeId);
    if (existing) return existing;
    const stopping = Promise.resolve().then(() => this.stopInstances(runtimeId));
    this.stoppingRuntimes.set(runtimeId, stopping);
    try { await stopping; }
    finally { if (this.stoppingRuntimes.get(runtimeId) === stopping) this.stoppingRuntimes.delete(runtimeId); }
  }

  async reconfigure<T>(runtimeId: AgentRuntimeId, save: () => Promise<T>): Promise<T> {
    this.assertRuntimeAvailable(runtimeId);
    if (this.isBusy(runtimeId)) throw new Error("此 Harness 仍有会话在运行，请先完成或取消后修改模型配置");
    // A shared provider cannot change while a new sibling session is starting.
    // Reserve the runtime before the asynchronous credential write begins.
    const updating = Promise.resolve().then(async () => {
      const result = await save();
      await this.stopInstances(runtimeId);
      return result;
    });
    const barrier = updating.then(() => {}, () => {});
    this.stoppingRuntimes.set(runtimeId, barrier);
    try { return await updating; }
    finally { if (this.stoppingRuntimes.get(runtimeId) === barrier) this.stoppingRuntimes.delete(runtimeId); }
  }

  private async stopInstances(runtimeId: AgentRuntimeId): Promise<void> {
    // Block new work first, settle admitted RPCs, then stop all instances.
    await Promise.all([...this.operations.values()].filter(op => op.runtimeId === runtimeId).map(op => op.settled));
    const results = await Promise.allSettled([...this.live.keys()]
      .filter(id => this.repository.get(id).runtimeId === runtimeId).map(async id => {
        await this.cancellations.get(id)?.catch(() => {});
        await this.stop(id);
      }));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  async stopAll(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled(agentRuntimeIds.map((runtimeId) => this.stopRuntime(runtimeId)));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const runtimeId = this.repository.get(id, true).runtimeId;
    this.assertRuntimeAvailable(runtimeId);
    const previous = this.operations.get(id)?.settled;
    const current = (previous ?? Promise.resolve()).then(() => {
      this.assertRuntimeAvailable(runtimeId);
      return action();
    });
    const settled = current.then(() => {}, () => {});
    this.operations.set(id, { runtimeId, settled });
    try { return await current; }
    finally { if (this.operations.get(id)?.settled === settled) this.operations.delete(id); }
  }

  private assertRuntimeAvailable(runtimeId: AgentRuntimeId): void {
    if (this.closing || this.stoppingRuntimes.has(runtimeId)) throw new Error("运行时正在关闭，请稍后再试");
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
    if (this.draining.has(id) || !this.live.has(id) || this.closing) return;
    const runtimeId = this.repository.get(id).runtimeId;
    if (this.stoppingRuntimes.has(runtimeId)) return;
    this.draining.add(id);
    void this.serial(id, async () => {
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
