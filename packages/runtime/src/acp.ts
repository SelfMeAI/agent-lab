import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ApprovalOption, RunEvent, RuntimePhase, RuntimeStatus } from "../../contracts/src/index";
import type { HarnessAdapter } from "./index";
import { FileChangeTracker } from "./file-change-tracker";

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
  private readonly approvals = new Map<string, { requestId: string | number; options: ApprovalOption[] }>();
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

  async start(workspace: string): Promise<void> {
    const canonical = await realpath(workspace);
    if (!(await stat(canonical)).isDirectory()) throw new Error("工作目录必须是文件夹");
    if (this.child && this.workspace === canonical && ["ready", "running", "approval"].includes(this.phase)) {
      this.emitStatus(this.phase, this.phase === "ready" ? `${this.label} 已就绪` : "当前会话仍在运行");
      return;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.boot(canonical);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async boot(workspace: string): Promise<void> {
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
        clientInfo: { name: "selfme-lab", version: "0.1.0" },
        clientCapabilities: {},
      }, 30000);
      const session = await this.request("session/new", { cwd: workspace, mcpServers: [] }, 30000);
      const sessionId = string(session.sessionId) ?? string(session.session_id);
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
    }).then((result) => {
      this.emitStatus("ready", `本轮已结束 · ${string(result.stopReason) ?? "完成"}`);
    }).catch((error: unknown) => {
      if (this.phase !== "idle") this.emitError(error instanceof Error ? error.message : String(error));
    });
  }

  async cancel(): Promise<void> {
    if (!this.sessionId || !["running", "approval"].includes(this.phase)) return;
    for (const approval of this.approvals.values()) {
      this.write({ jsonrpc: "2.0", id: approval.requestId, result: { outcome: { outcome: "cancelled" } } });
    }
    this.approvals.clear();
    this.notify("session/cancel", { sessionId: this.sessionId });
    this.emitStatus("cancelling", "正在取消任务");
  }

  async respondApproval(requestId: string | number, optionId: string): Promise<void> {
    const approval = this.approvals.get(String(requestId));
    if (!approval) throw new Error("审批请求已失效");
    if (!approval.options.some((option) => option.optionId === optionId)) throw new Error("无效的审批选项");
    this.write({ jsonrpc: "2.0", id: requestId, result: { outcome: { outcome: "selected", optionId } } });
    this.approvals.delete(String(requestId));
    this.emitStatus("running", "审批已提交，继续执行");
  }

  async stop(): Promise<void> {
    const child = this.child;
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
    if (method === "session/update") { this.handleUpdate(object(message.params)); return; }
    if (method === "session/request_permission") { this.handleApproval(message); return; }
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
    if (kind === "agent_message_chunk") this.emit("message", common);
    else if (kind === "agent_thought_chunk") this.emit("thought", common);
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
    this.approvals.set(String(requestId), { requestId, options });
    this.emitStatus("approval", "等待你的审批");
    this.emit("approval", {
      title: "需要授权",
      text: title ?? toolCallId ?? `${this.label} 请求执行受保护操作`,
      approval: { requestId, title: title ?? `${this.label} 操作授权`, options, toolCallId },
      raw: params,
    });
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.child) return;
    this.child = null;
    this.sessionId = null;
    this.workspace = null;
    this.fileTracker?.clear();
    this.fileTracker = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.approvals.clear();
    this.toolTitles.clear();
    const detail = this.stderrTail.at(-1);
    this.emitError(detail ? `${error.message} · ${detail.slice(0, 400)}` : error.message);
  }

  private emitStatus(phase: RuntimePhase, text: string): void {
    this.phase = phase;
    this.emit("status", { phase, text });
  }

  private emitError(text: string): void {
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
