import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentQuestion, AgentQuestionAnswers, ApprovalOption, RunEvent, RuntimePhase, RuntimeStatus } from "../../contracts/src/index";
import type { HarnessAdapter } from "./index";
import { FileChangeTracker } from "./file-change-tracker";
import { SteeringTracker, steeringError } from "./steering";
import { kimiFormAnswerContent, kimiFormCustomFields, kimiFormQuestions, qwenQuestions, validateQuestionAnswers, type KimiCustomFields } from "./user-questions";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
}

export interface AcpLaunch {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  secret?: string;
}

export interface AcpAdapterOptions {
  id: string;
  label: string;
  probePath: string;
  readyDetail: string;
  missingDetail: string;
  /** Official ACP client extension called at the harness's tool boundary. */
  steeringDrainMethod?: string;
  closeSession?: boolean;
  promptMeta?(text: string): JsonObject;
  /** Persist an explicitly chosen native permission before releasing the action. */
  rememberPermission?(option: ApprovalOption): void;
  launch(workspace: string): Promise<AcpLaunch>;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map(contentText).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join("\n") : undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const item = object(value);
  return string(item.text)
    ?? (item.content === undefined ? undefined : contentText(item.content))
    ?? string(item.output)
    ?? string(item.summary);
}

/** Shared ACP transport for independently packaged harness experiments. */
export class AcpAdapter implements HarnessAdapter {
  readonly id: string;
  readonly label: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly approvals = new Map<string, { requestId: string | number; options: ApprovalOption[]; questions?: AgentQuestion[]; form?: KimiCustomFields }>();
  private readonly toolTitles = new Map<string, string>();
  private nextRequestId = 0;
  private sequence = 0;
  private sessionId: string | null = null;
  private workspace: string | null = null;
  private phase: RuntimePhase = "idle";
  private runId = "session";
  private startPromise: Promise<void> | null = null;
  private stderrTail: string[] = [];
  private secret: string | undefined;
  private fileTracker: FileChangeTracker | null = null;
  private readonly steering = new SteeringTracker((extra) => this.emit("delivery", extra));
  private readonly nativeSteering = new Map<string, string>();

  constructor(private readonly options: AcpAdapterOptions) {
    this.id = options.id;
    this.label = options.label;
  }

  async probe(): Promise<RuntimeStatus> {
    try {
      await access(this.options.probePath);
      return { id: this.id, label: this.label, availability: "ready", detail: this.options.readyDetail };
    } catch {
      return { id: this.id, label: this.label, availability: "missing", detail: this.options.missingDetail };
    }
  }

  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isBusy(): boolean {
    return ["starting", "running", "approval", "cancelling"].includes(this.phase);
  }

  getResumeRef(): string | null { return this.sessionId; }

  async start(workspace: string, resumeRef?: string): Promise<void> {
    const canonical = await realpath(workspace);
    if (!(await stat(canonical)).isDirectory()) throw new Error("工作目录必须是文件夹");
    if (this.child && this.workspace === canonical && ["ready", "running", "approval"].includes(this.phase)) {
      this.emitStatus(this.phase, this.phase === "ready" ? `${this.label} 已就绪` : "当前会话仍在运行");
      return;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.boot(canonical, resumeRef);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async boot(workspace: string, resumeRef?: string): Promise<void> {
    if (this.child) await this.stop();
    await access(this.options.probePath);
    const launch = await this.options.launch(workspace);
    this.secret = launch.secret;
    const child = spawn(launch.executable, launch.args, {
      cwd: workspace,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    this.workspace = workspace;
    this.fileTracker = new FileChangeTracker(workspace);
    this.sessionId = null;
    this.stderrTail = [];
    this.approvals.clear();
    this.toolTitles.clear();
    this.emitStatus("starting", `正在连接 ${this.label} ACP`);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(child, line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail.push(...chunk.toString("utf8").split(/\r?\n/u).filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-12);
    });
    child.on("error", (error) => this.handleExit(child, error));
    child.on("exit", (code, signal) => this.handleExit(child, new Error(`${this.label} 已退出（${signal ?? code ?? "unknown"}）`)));

    try {
      await this.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "agent-lab", version: "0.1.0" },
        clientCapabilities: this.id === "kimi-code" ? { elicitation: { form: {} } } : {},
      }, 30000);
      const session = resumeRef
        ? await this.request("session/resume", { sessionId: resumeRef, cwd: workspace, mcpServers: [] }, 30000)
        : await this.request("session/new", { cwd: workspace, mcpServers: [] }, 30000);
      const sessionId = resumeRef ?? string(session.sessionId) ?? string(session.session_id);
      if (!sessionId) throw new Error(`${this.label} 未返回 ACP sessionId`);
      this.sessionId = sessionId;
      this.emitStatus("ready", `${this.label} 已就绪`);
    } catch (error) {
      this.emitError(error instanceof Error ? error.message : String(error));
      await this.stop();
      throw error;
    }
  }

  async send(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (!text) throw new Error("请输入任务内容");
    if (!this.sessionId || this.phase !== "ready") throw new Error(`${this.label} 尚未就绪，或正在执行上一轮任务`);
    this.runId = randomUUID();
    this.emitStatus("running", "正在执行任务");
    void this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
      ...(this.options.promptMeta ? { _meta: this.options.promptMeta(text) } : {}),
    }).then((result) => {
      this.emitStatus("ready", `本轮已结束 · ${string(result.stopReason) ?? "完成"}`);
    }).catch((error: unknown) => {
      if (this.phase !== "idle") this.emitError(error instanceof Error ? error.message : String(error));
    });
  }

  async cancel(): Promise<void> {
    if (!this.sessionId || !["running", "approval"].includes(this.phase)) return;
    for (const approval of this.approvals.values()) {
      this.write({ jsonrpc: "2.0", id: approval.requestId, result: approval.form ? { action: "cancel" } : { outcome: { outcome: "cancelled" } } });
    }
    this.approvals.clear();
    this.nativeSteering.clear();
    this.notify("session/cancel", { sessionId: this.sessionId });
    this.emitStatus("cancelling", "正在取消任务");
  }

  async steer(prompt: string, messageId: string): Promise<void> {
    if (!this.sessionId || !["running", "approval"].includes(this.phase)) throw new Error("本轮已结束，补充指令未提交");
    const text = this.steering.begin(messageId, prompt);
    if (this.options.steeringDrainMethod) {
      this.nativeSteering.set(messageId, text);
      this.steering.accepted(messageId);
      return;
    }
    try {
      await this.request("_agent_lab/steer", { sessionId: this.sessionId, text, messageId }, 15000);
      this.steering.accepted(messageId);
    } catch (error) { const failure = steeringError(error, this.secret); this.steering.rejected(messageId, failure); throw failure; }
  }

  async respondApproval(requestId: string | number, optionId: string, answers?: AgentQuestionAnswers): Promise<void> {
    const approval = this.approvals.get(String(requestId));
    if (!approval) throw new Error("审批请求已失效");
    if (!approval.options.some((option) => option.optionId === optionId)) throw new Error("无效的审批选项");
    let result: JsonObject = { outcome: { outcome: "selected", optionId } };
    if (approval.questions !== undefined) {
      const allow = approval.options.find(option => option.optionId === optionId)!.kind.includes("allow");
      if (allow) {
        const checked = validateQuestionAnswers(approval.questions, answers);
        result = approval.form
          ? { action: "accept", content: kimiFormAnswerContent(approval.questions, checked, approval.form) }
          : { ...result, answers: Object.fromEntries(Object.entries(checked).map(([id, values]) => [id, values.join(", ")])) };
      } else if (approval.form) result = { action: "cancel" };
    } else {
      if (answers !== undefined) throw new Error("授权请求不能提交问题答案");
      this.options.rememberPermission?.(approval.options.find(option => option.optionId === optionId)!);
    }
    this.write({ jsonrpc: "2.0", id: approval.requestId, result });
    this.approvals.delete(String(requestId));
    this.emitStatus("running", approval.questions !== undefined ? optionId === "cancel" ? "已取消回答" : "答案已提交，继续执行" : "审批已提交，继续执行");
  }

  async stop(): Promise<void> {
    const child = this.child;
    const sessionId = this.sessionId;
    if (child && sessionId && this.phase === "ready" && this.options.closeSession !== false) {
      try { await this.request("session/close", { sessionId }, 5000); }
      catch (error) { console.warn(`${this.label} session/close failed:`, error); }
    }
    this.child = null;
    this.sessionId = null;
    this.workspace = null;
    this.fileTracker?.clear();
    this.fileTracker = null;
    this.approvals.clear();
    this.toolTitles.clear();
    if (child) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => { if (!settled) { settled = true; clearTimeout(termTimer); clearTimeout(killTimer); resolve(); } };
        const termTimer = setTimeout(() => child.kill("SIGTERM"), 1500);
        const killTimer = setTimeout(() => { child.kill("SIGKILL"); finish(); }, 4000);
        child.once("exit", finish);
        child.once("error", finish);
        child.stdin.end();
      });
    }
    for (const pending of this.pending.values()) pending.reject(new Error(`${this.label} 连接已停止`));
    this.pending.clear();
    this.secret = undefined;
    this.emitStatus("idle", `${this.label} 已停止`);
  }

  private request(method: string, params: JsonObject, timeoutMs = 0): Promise<JsonObject> {
    const id = ++this.nextRequestId;
    return new Promise<JsonObject>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (handler: (value: never) => void, value: never): void => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        handler(value);
      };
      this.pending.set(id, {
        resolve: (value) => finish(resolve as (value: never) => void, value as never),
        reject: (error) => finish(reject as (value: never) => void, error as never),
      });
      if (timeoutMs) timer = setTimeout(() => this.pending.get(id)?.reject(new Error(`${method} 等待超时`)), timeoutMs);
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: JsonObject): void {
    if (!this.child || !this.child.stdin.writable) throw new Error(`${this.label} ACP 连接已断开`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (child !== this.child || !line.trim()) return;
    let message: JsonObject;
    try {
      message = object(JSON.parse(line));
    } catch {
      this.emitError(`${this.label} 返回了无法解析的 ACP 消息`);
      return;
    }
    const method = string(message.method);
    if (method === "$/cancel_request") {
      const requestId = object(message.params).id;
      if (typeof requestId !== "string" && typeof requestId !== "number") return;
      const approval = this.approvals.get(String(requestId));
      if (approval) {
        this.approvals.delete(String(requestId));
        this.emit("approval_result", { text: approval.questions !== undefined ? "该提问已由运行时取消" : undefined,
          approval: { ...approval, title: "请求已取消" } });
        if (!this.approvals.size && this.phase === "approval") this.emitStatus("running", `${this.label} 正在继续工作`);
      }
      return;
    }
    if (method === "session/update") { this.handleUpdate(object(message.params)); return; }
    if (method === "session/request_permission") { this.handleApproval(message); return; }
    if (method === "elicitation/create" && this.id === "kimi-code" && message.id !== undefined) { this.handleQuestionForm(message); return; }
    if (method && (typeof message.id === "number" || typeof message.id === "string")) {
      if (method === this.options.steeringDrainMethod && object(message.params).sessionId === this.sessionId) {
        // Queue stays app-owned and starts after end_turn. Only explicit Steer
        // inputs are handed to Qwen's existing mid-turn drain; no prompt restart.
        const messages = ["running", "approval"].includes(this.phase) ? [...this.nativeSteering.entries()] : [];
        this.write({ jsonrpc: "2.0", id: message.id, result: { messages: messages.map(([, text]) => text), hasQueuedPrompt: false } });
        for (const [id] of messages) { this.nativeSteering.delete(id); this.steering.incorporated(id); }
      } else {
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not supported by this client" } });
      }
      return;
    }
    const id = message.id;
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    const error = object(message.error);
    if (message.error) pending.reject(new Error(string(error.message) ?? "ACP 请求失败"));
    else pending.resolve(object(message.result));
  }

  private handleUpdate(params: JsonObject): void {
    const update = object(params.update);
    const kind = string(update.sessionUpdate) ?? "update";
    if (kind === "agent_lab_steering") {
      const id = string(update.messageId);
      if (id && update.state === "incorporated") this.steering.incorporated(id);
      else if (id) this.steering.unconfirmed(id, string(update.detail) ?? "未确认接入本轮任务");
      return;
    }
    if (["user_message_chunk", "available_commands_update", "session_info_update", "current_mode_update", "config_option_update"].includes(kind)) return;
    const toolCallId = string(update.toolCallId);
    if (toolCallId && string(update.title)) this.toolTitles.set(toolCallId, string(update.title)!);
    if (kind === "tool_call" && toolCallId) this.fileTracker?.start(toolCallId, string(update.title), update.rawInput);
    const fileDiff = kind === "tool_call_update" && toolCallId
      ? this.fileTracker?.finish(toolCallId, update.status === "completed") : undefined;
    const raw = fileDiff ? { ...update, content: [...(Array.isArray(update.content) ? update.content : []), fileDiff] } : update;
    const common = {
      text: contentText(update.content) ?? string(update.summary),
      title: string(update.title),
      toolCallId,
      toolStatus: string(update.status),
      raw,
    };
    if (kind === "agent_message_chunk") { if (common.text) this.emit("message", common); }
    else if (kind === "agent_thought_chunk") { if (common.text) this.emit("thought", common); }
    else if (kind === "tool_call" || kind === "tool_call_update") this.emit("tool", common);
    else if (kind === "plan" || kind === "plan_update") this.emit("status", { ...common, title: "执行计划" });
    else if (kind === "usage_update") this.emit("status", { ...common, title: "用量" });
    else this.emit("status", { ...common, title: kind });
  }

  private handleApproval(message: JsonObject): void {
    const requestId = message.id;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const params = object(message.params);
    const toolCall = object(params.toolCall);
    const toolCallId = string(toolCall.toolCallId);
    const title = string(toolCall.title) ?? (toolCallId ? this.toolTitles.get(toolCallId) : undefined);
    const options = (Array.isArray(params.options) ? params.options : []).map((entry) => {
      const option = object(entry);
      return { optionId: string(option.optionId) ?? "", name: string(option.name) ?? "选项", kind: string(option.kind) ?? "" };
    }).filter((option) => option.optionId);
    const questions = this.id === "qwen-code" ? qwenQuestions(toolCall) : undefined;
    this.approvals.set(String(requestId), { requestId, options, questions });
    this.emitStatus("approval", questions !== undefined ? "等待你回答问题" : "等待你的审批");
    this.emit("approval", {
      title: questions !== undefined ? "需要你回答" : "需要授权",
      text: title ?? toolCallId ?? `${this.label} 请求执行受保护操作`,
      approval: { requestId, title: title ?? `${this.label} 操作授权`, options, toolCallId, questions },
      raw: params,
    });
  }

  private handleQuestionForm(message: JsonObject): void {
    const requestId = message.id;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const params = object(message.params);
    if (params.mode !== "form") {
      this.write({ jsonrpc: "2.0", id: requestId, result: { action: "cancel" } });
      return;
    }
    const questions = kimiFormQuestions(params);
    const options: ApprovalOption[] = [
      { optionId: "submit", name: "提交答案", kind: "allow_once" },
      { optionId: "cancel", name: "取消回答", kind: "reject_once" },
    ];
    this.approvals.set(String(requestId), { requestId, options, questions, form: kimiFormCustomFields(params) ?? {} });
    this.emitStatus("approval", "等待你回答问题");
    this.emit("approval", { title: "需要你回答", text: string(params.message),
      approval: { requestId, title: "需要你回答", options, questions, toolCallId: string(params.toolCallId) }, raw: params });
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.child) return;
    this.child = null;
    this.sessionId = null;
    this.workspace = null;
    this.fileTracker?.clear();
    this.fileTracker = null;
    const detail = this.stderrTail.slice(-6).join(" · ");
    const raw = detail ? `${error.message} · ${detail.slice(0, 1200)}` : error.message;
    const failure = new Error(this.secret ? raw.replaceAll(this.secret, "[redacted]") : raw);
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
    this.approvals.clear();
    this.toolTitles.clear();
    this.emitError(failure.message);
  }

  private emitStatus(phase: RuntimePhase, text: string): void {
    if (["idle", "ready", "error"].includes(phase)) { this.steering.finish(); this.nativeSteering.clear(); }
    this.phase = phase;
    this.emit("status", { phase, text });
  }

  private emitError(text: string): void {
    this.steering.finish("运行出错，未确认补充指令是否接入");
    this.nativeSteering.clear();
    this.phase = "error";
    this.emit("error", { phase: "error", text: this.secret ? text.replaceAll(this.secret, "[redacted]") : text });
  }

  private emit(kind: RunEvent["kind"], extra: Partial<RunEvent>): void {
    const event: RunEvent = {
      runtimeId: this.id,
      runId: this.runId,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      source: this.label,
      kind,
      ...extra,
    };
    for (const listener of this.listeners) listener(event);
  }
}
