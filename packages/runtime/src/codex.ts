import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, delimiter } from "node:path";
import { createInterface } from "node:readline";
import type { AgentQuestion, AgentQuestionAnswers, ApprovalOption, RunEvent, RuntimePhase, RuntimeStatus } from "../../contracts/src/index";
import type { HarnessAdapter } from "./index";
import { SteeringTracker, steeringError } from "./steering";
import { codexQuestions, validateQuestionAnswers } from "./user-questions";
import { ExactNativePermissions } from "./exact-native-permissions";
import type { SessionPermissionStore } from "./session-permissions";

type JsonObject = Record<string, unknown>;
type Pending = { resolve(value: JsonObject): void; reject(error: Error): void };

export interface CodexProvider {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface CodexAdapterOptions {
  executable: string;
  homeDirectory: string;
  provider(): Promise<CodexProvider>;
  permissions?: SessionPermissionStore;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toml(value: string): string {
  return JSON.stringify(value);
}

function errorText(value: unknown): string {
  const item = object(value);
  return string(item.message) ?? string(item.additionalDetails) ?? "Codex 请求失败";
}

export class CodexAdapter implements HarnessAdapter {
  private readonly steering = new SteeringTracker((extra) => this.emit("delivery", extra));
  private readonly seenUserMessageIds = new Set<string>();
  readonly id = "codex";
  readonly label = "Codex";
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private readonly pending = new Map<number, Pending>();
  private readonly approvals = new Map<string, { requestId: number | string; options: ApprovalOption[]; questions?: AgentQuestion[]; permissionKey?: string; decisions?: Map<string, unknown> }>();
  private readonly fileApprovalTargets = new Map<string, unknown[]>();
  private readonly permissions: ExactNativePermissions;
  private readonly toolText = new Map<string, string>();
  private readonly activeTools = new Set<string>();
  private readonly messageDeltaIds = new Set<string>();
  private nextRequestId = 0;
  private sequence = 0;
  private runId = "session";
  private threadId: string | null = null;
  private turnId: string | null = null;
  private workspace: string | null = null;
  private phase: RuntimePhase = "idle";
  private startPromise: Promise<void> | null = null;
  private apiKey: string | null = null;
  private stderrTail: string[] = [];

  constructor(private readonly options: CodexAdapterOptions) { this.permissions = new ExactNativePermissions("codex-native-approvals-v1", options.permissions); }

  async probe(): Promise<RuntimeStatus> {
    try {
      await access(this.options.executable);
      await access(join(dirname(dirname(this.options.executable)), "codex-resources", "codex-code-mode-host"));
      return { id: this.id, label: this.label, availability: "ready", detail: "项目内编译的 Codex app-server" };
    } catch {
      return { id: this.id, label: this.label, availability: "missing", detail: "项目内 Codex 运行时尚未准备好" };
    }
  }

  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isBusy(): boolean {
    return ["starting", "running", "approval", "cancelling"].includes(this.phase);
  }

  getResumeRef(): string | null { return this.threadId; }

  async start(workspace: string, resumeRef?: string): Promise<void> {
    const canonical = await realpath(workspace);
    if (!(await stat(canonical)).isDirectory()) throw new Error("工作目录必须是文件夹");
    if (this.child && this.workspace === canonical && ["ready", "running", "approval"].includes(this.phase)) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.boot(canonical, resumeRef);
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  private async boot(workspace: string, resumeRef?: string): Promise<void> {
    if (this.child) await this.stop();
    await access(this.options.executable);
    const provider = await this.options.provider();
    this.apiKey = provider.apiKey;
    await mkdir(this.options.homeDirectory, { recursive: true, mode: 0o700 });
    const config = [
      `model = ${toml(provider.model)}`,
      'model_provider = "agent_lab"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      "",
      "[features]",
      "default_mode_request_user_input = true",
      "",
      "[features.code_mode_host]",
      "enabled = true",
      "disable_in_process_fallback = true",
      "",
      "[model_providers.agent_lab]",
      'name = "Agent Lab provider"',
      `base_url = ${toml(provider.baseUrl)}`,
      'env_key = "AGENT_LAB_CODEX_API_KEY"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    await writeFile(join(this.options.homeDirectory, "config.toml"), config, { mode: 0o600 });
    const runtimeRoot = dirname(dirname(this.options.executable));
    const child = spawn(this.options.executable, ["app-server"], {
      cwd: workspace,
      env: {
        ...process.env,
        CODEX_HOME: this.options.homeDirectory,
        AGENT_LAB_CODEX_API_KEY: provider.apiKey,
        PATH: `${join(runtimeRoot, "codex-path")}${delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    this.workspace = workspace;
    this.permissions.load(workspace);
    this.fileApprovalTargets.clear();
    this.threadId = null;
    this.turnId = null;
    this.approvals.clear();
    this.toolText.clear();
    this.activeTools.clear();
    this.messageDeltaIds.clear();
    this.stderrTail = [];
    this.emitStatus("starting", "正在连接 Codex app-server");
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(child, line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail.push(...chunk.toString("utf8").split(/\r?\n/u).filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-12);
    });
    child.on("error", (error) => this.handleExit(child, error));
    child.on("exit", (code, signal) => this.handleExit(child, new Error(`Codex 已退出（${signal ?? code ?? "unknown"}）`)));

    try {
      await this.request("initialize", {
        clientInfo: { name: "agent_lab", title: "Agent Lab", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }, 30000);
      this.notify("initialized", {});
      const threadSettings = {
        cwd: workspace,
        model: provider.model,
        modelProvider: "agent_lab",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      };
      const result = await this.request(resumeRef ? "thread/resume" : "thread/start", resumeRef
        ? { ...threadSettings, threadId: resumeRef }
        : { ...threadSettings, serviceName: "agent_lab" }, 45000);
      const threadId = string(object(result.thread).id);
      if (!threadId) throw new Error("Codex 未返回 thread.id");
      this.threadId = threadId;
      this.emitStatus("ready", "Codex 已就绪");
    } catch (error) {
      this.emitError(error instanceof Error ? error.message : String(error));
      await this.stop();
      throw error;
    }
  }

  async send(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (!text) throw new Error("请输入任务内容");
    if (!this.threadId || this.phase !== "ready") throw new Error("Codex 尚未就绪，或正在执行上一轮任务");
    this.runId = randomUUID();
    this.seenUserMessageIds.clear();
    this.turnId = null;
    this.emitStatus("running", "Codex 正在执行任务");
    try {
      const result = await this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text }],
      }, 45000);
      if (this.isBusy()) this.turnId = string(object(result.turn).id) ?? this.turnId;
    } catch (error) {
      this.emitError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (!this.threadId || !this.turnId || !["running", "approval"].includes(this.phase)) return;
    const threadId = this.threadId, turnId = this.turnId;
    for (const approval of this.approvals.values()) this.write({ id: approval.requestId, result: approval.questions !== undefined ? { answers: {} } : { decision: "cancel" } });
    this.approvals.clear();
    this.emitStatus("cancelling", "正在取消 Codex 任务");
    try {
      await this.request("turn/interrupt", { threadId, turnId }, 15000);
      // turn/completed can precede the RPC reply; never overwrite its ready state.
    } catch (error) {
      if (this.turnId === turnId && this.phase === "cancelling") {
        this.emitStatus("running", "停止请求未确认，请检查当前任务");
      }
      throw error;
    }
  }

  async steer(prompt: string, messageId: string): Promise<void> {
    if (!this.threadId || !this.turnId || !["running", "approval"].includes(this.phase)) throw new Error("本轮尚未开始或已结束，补充指令未提交");
    const text = this.steering.begin(messageId, prompt);
    try {
      const expectedTurnId = this.turnId;
      const result = await this.request("turn/steer", {
        threadId: this.threadId, expectedTurnId, input: [{ type: "text", text }],
      }, 15000);
      if (result.turnId !== expectedTurnId) throw new Error("Codex 未确认接入当前任务");
      this.steering.accepted(messageId);
    } catch (error) { const failure = steeringError(error, this.apiKey); this.steering.rejected(messageId, failure); throw failure; }
  }

  async respondApproval(requestId: string | number, optionId: string, answers?: AgentQuestionAnswers): Promise<void> {
    const approval = this.approvals.get(String(requestId));
    if (!approval || !approval.options.some((option) => option.optionId === optionId)) throw new Error("审批请求已失效或选项无效");
    let result: JsonObject = { decision: approval.decisions?.get(optionId) ?? optionId };
    if (approval.questions !== undefined) {
      const checked = optionId === "submit" ? validateQuestionAnswers(approval.questions, answers) : {};
      result = { answers: Object.fromEntries(Object.entries(checked).map(([id, values]) => [id, { answers: values }])) };
    } else if (answers !== undefined) throw new Error("授权请求不能提交问题答案");
    if (optionId === "acceptForSession" && approval.permissionKey) this.permissions.remember(approval.permissionKey);
    this.write({ id: approval.requestId, result });
    this.approvals.delete(String(requestId));
    this.emitStatus("running", approval.questions !== undefined ? optionId === "cancel" ? "已取消回答" : "答案已提交，继续执行" : "审批已提交，继续执行");
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.threadId = null;
    this.turnId = null;
    this.workspace = null;
    this.fileApprovalTargets.clear();
    this.approvals.clear();
    this.toolText.clear();
    this.activeTools.clear();
    this.messageDeltaIds.clear();
    if (child) await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; clearTimeout(term); clearTimeout(kill); resolve(); } };
      const term = setTimeout(() => child.kill("SIGTERM"), 1000);
      const kill = setTimeout(() => { child.kill("SIGKILL"); finish(); }, 4000);
      child.once("exit", finish);
      child.once("error", finish);
      child.stdin.end();
    });
    for (const pending of this.pending.values()) pending.reject(new Error("Codex 连接已停止"));
    this.pending.clear();
    this.apiKey = null;
    this.emitStatus("idle", "Codex 已停止");
  }

  private request(method: string, params: JsonObject, timeoutMs = 0): Promise<JsonObject> {
    const id = ++this.nextRequestId;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => this.pending.get(id)?.reject(new Error(`${method} 等待超时`)), timeoutMs) : null;
      this.pending.set(id, {
        resolve: (value) => { if (timer) clearTimeout(timer); this.pending.delete(id); resolve(value); },
        reject: (error) => { if (timer) clearTimeout(timer); this.pending.delete(id); reject(error); },
      });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private notify(method: string, params: JsonObject): void { this.write({ method, params }); }

  private write(message: JsonObject): void {
    if (!this.child || !this.child.stdin.writable) throw new Error("Codex app-server 连接已断开");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (child !== this.child || !line.trim()) return;
    let message: JsonObject;
    try { message = object(JSON.parse(line)); }
    catch { this.emitError("Codex 返回了无法解析的消息"); return; }
    const method = string(message.method);
    if (method && (typeof message.id === "number" || typeof message.id === "string")) {
      this.handleServerRequest(message, method);
      return;
    }
    if (method) { this.handleNotification(method, object(message.params)); return; }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.error) pending.reject(new Error(errorText(message.error)));
    else pending.resolve(object(message.result));
  }

  private handleServerRequest(message: JsonObject, method: string): void {
    const requestId = message.id as string | number;
    const params = object(message.params);
    if (method === "item/tool/requestUserInput") {
      const questions = codexQuestions(params.questions);
      const options: ApprovalOption[] = [
        { optionId: "submit", name: "提交答案", kind: "allow_once" },
        { optionId: "cancel", name: "取消回答", kind: "reject_once" },
      ];
      this.approvals.set(String(requestId), { requestId, options, questions });
      this.emitStatus("approval", "等待你回答问题");
      this.emit("approval", { title: "需要你回答", approval: { requestId, title: "需要你回答", options, questions, toolCallId: string(params.itemId) }, raw: params });
      return;
    }
    if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") {
      this.write({ id: requestId, error: { code: -32601, message: "Agent Lab does not support this request" } });
      this.emit("error", { text: `Codex 请求了尚未支持的交互：${method}` });
      return;
    }
    const defaults: ApprovalOption[] = [
      { optionId: "accept", name: "允许一次", kind: "allow" },
      { optionId: "acceptForSession", name: "本会话始终允许", kind: "allow_session" },
      { optionId: "decline", name: "拒绝", kind: "reject" },
    ];
    const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : null;
    const decisions = new Map<string, unknown>();
    const options: ApprovalOption[] = offered ? offered.flatMap((value): ApprovalOption[] => {
      if (typeof value === "string") {
        const known = defaults.find(option => option.optionId === value);
        if (known) { decisions.set(value, value); return [known]; }
        if (value === "cancel") { decisions.set(value, value); return [{ optionId: value, name: "取消", kind: "reject_once" }]; }
      } else {
        const amendment = object(object(value).acceptWithExecpolicyAmendment).execpolicy_amendment;
        if (Array.isArray(amendment) && amendment.length && amendment.every(token => typeof token === "string")) {
          decisions.set("acceptWithExecpolicyAmendment", value);
          return [{ optionId: "acceptWithExecpolicyAmendment", name: "本会话允许此命令前缀", kind: "allow_session", detail: `仅当前会话的原生规则：${amendment.join(" ")}` }];
        }
      }
      return [];
    }) : defaults;
    const title = method.includes("commandExecution") ? "命令执行授权" : "文件修改授权";
    const detail = string(params.reason) ?? string(params.command) ?? string(params.cwd) ?? title;
    const targets = this.fileApprovalTargets.get(String(params.itemId));
    // No restoration without a meaningful native target. Never approve an
    // opaque request solely because its UI title/option says "same operation".
    const canRestore = method.includes("commandExecution") ? Boolean(string(params.command)) : Boolean(string(params.grantRoot) || targets?.length);
    const permissionKey = canRestore ? this.permissions.fingerprint(method, params, targets) : undefined;
    if (permissionKey && this.permissions.has(permissionKey) && (!offered || offered.includes("acceptForSession"))) {
      this.write({ id: requestId, result: { decision: "acceptForSession" } });
      this.emit("approval_result", { title: "已恢复会话授权", approval: { requestId, title, options, toolCallId: string(params.itemId) },
        approvalDecision: options.find(option => option.optionId === "acceptForSession"), approvalDecisionSource: "restored" });
      return;
    }
    this.approvals.set(String(requestId), { requestId, options, permissionKey, decisions });
    this.emitStatus("approval", "等待你的审批");
    this.emit("approval", {
      title,
      text: detail,
      approval: { requestId, title, options, toolCallId: string(params.itemId) },
      raw: params,
    });
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (typeof requestId !== "string" && typeof requestId !== "number") return;
      const approval = this.approvals.get(String(requestId));
      if (approval) {
        this.approvals.delete(String(requestId));
        this.emit("approval_result", { title: "提问已结束", text: approval.questions !== undefined ? "该提问已由运行时结束" : undefined,
          approval: { ...approval, title: "请求已结束" } });
        if (!this.approvals.size && this.phase === "approval") this.emitStatus("running", "Codex 正在继续工作");
      }
      return;
    }
    if (method === "turn/started") {
      this.turnId = string(object(params.turn).id) ?? this.turnId;
      this.emitStatus("running", "Codex 正在执行任务");
      return;
    }
    if (method === "turn/completed") {
      const turn = object(params.turn);
      this.turnId = null;
      this.approvals.clear();
      const status = string(turn.status);
      for (const itemId of this.activeTools) this.emit("tool", { toolCallId: itemId, toolStatus: status === "completed" ? "finished" : "interrupted" });
      this.activeTools.clear();
      this.fileApprovalTargets.clear();
      if (status === "failed") this.emitError(errorText(turn.error));
      else this.emitStatus("ready", status === "interrupted" ? "本轮已取消" : "本轮已完成");
      return;
    }
    if (method === "item/agentMessage/delta") {
      const itemId = string(params.itemId);
      if (itemId) this.messageDeltaIds.add(itemId);
      const text = string(params.delta);
      if (text) this.emit("message", { text });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      const text = string(params.delta);
      if (text) this.emit("thought", { text });
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      const itemId = string(params.itemId);
      if (!itemId) return;
      const text = `${this.toolText.get(itemId) ?? ""}${string(params.delta) ?? ""}`;
      this.toolText.set(itemId, text.slice(-20000));
      this.emit("tool", { toolCallId: itemId, toolStatus: "running", text: this.toolText.get(itemId) });
      return;
    }
    if (method === "item/fileChange/patchUpdated") {
      const itemId = string(params.itemId);
      if (itemId && Array.isArray(params.changes)) this.fileApprovalTargets.set(itemId, params.changes.map(change => {
        const file = object(change); return { path: file.path, kind: file.kind };
      }));
      if (itemId) this.emit("tool", {
        toolCallId: itemId,
        title: "文件修改",
        toolStatus: "running",
        raw: { type: "fileChange", changes: params.changes },
      });
      return;
    }
    if (method === "turn/diff/updated") {
      const turnId = string(params.turnId) ?? this.turnId;
      if (turnId && typeof params.diff === "string") {
        const toolCallId = `turn-diff:${turnId}`;
        this.activeTools.add(toolCallId);
        this.emit("tool", { toolCallId, title: "本轮文件变更", toolStatus: "running", raw: { type: "turnDiff", diff: params.diff } });
      }
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.handleItem(object(params.item), method === "item/completed");
      return;
    }
    if (method === "turn/plan/updated") {
      this.emit("status", { title: "执行计划", raw: params });
      return;
    }
    if (method === "warning" || method === "configWarning") {
      this.emit("status", { title: "Codex 提示", text: string(params.message) ?? string(params.summary), raw: params });
      return;
    }
    if (method === "error") {
      const message = errorText(params.error);
      if (params.willRetry === true || /^Reconnecting\.\.\./iu.test(message)) this.emitStatus("running", `Codex 正在重连 · ${message}`);
      else this.emit("error", { text: message, raw: params });
    }
  }

  private handleItem(item: JsonObject, completed: boolean): void {
    const type = string(item.type);
    const itemId = string(item.id);
    if (type === "fileChange" && itemId) {
      if (completed) this.fileApprovalTargets.delete(itemId);
      else if (Array.isArray(item.changes)) this.fileApprovalTargets.set(itemId, item.changes.map(change => {
        const file = object(change); return { path: file.path, kind: file.kind };
      }));
    }
    if (type === "agentMessage") {
      if (completed && itemId && !this.messageDeltaIds.has(itemId) && string(item.text)) this.emit("message", { text: string(item.text) });
      return;
    }
    if (type === "userMessage") {
      if (itemId && this.seenUserMessageIds.has(itemId)) return;
      if (itemId) this.seenUserMessageIds.add(itemId);
      else if (!completed) return;
      const text = (Array.isArray(item.content) ? item.content : []).map((part) => string(object(part).text) ?? "").join("\n");
      this.steering.match(text);
      return;
    }
    if (type === "reasoning") return;
    if (type === "commandExecution" || type === "fileChange" || type === "mcpToolCall" || type === "webSearch" || type === "dynamicToolCall") {
      const title = type === "commandExecution" ? string(item.command) ?? "命令执行"
        : type === "fileChange" ? "文件修改"
          : type === "webSearch" ? "网页搜索"
            : string(item.tool) ?? type;
      this.emit("tool", {
        toolCallId: itemId,
        title,
        toolStatus: string(item.status) ?? (completed ? "completed" : "running"),
        text: string(item.aggregatedOutput) ?? (itemId ? this.toolText.get(itemId) : undefined),
        raw: item,
      });
      if (itemId) {
        if (completed) { this.activeTools.delete(itemId); this.toolText.delete(itemId); }
        else this.activeTools.add(itemId);
      }
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (child !== this.child) return;
    this.child = null;
    this.threadId = null;
    this.turnId = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.approvals.clear();
    const detail = this.stderrTail.at(-1);
    this.emitError(detail ? `${error.message} · ${detail.slice(0, 400)}` : error.message);
  }

  private emitStatus(phase: RuntimePhase, text: string): void {
    if (["idle", "ready", "error"].includes(phase)) this.steering.finish();
    this.phase = phase; this.emit("status", { phase, text });
  }

  private emitError(text: string): void {
    this.steering.finish("运行出错，未确认补充指令是否接入");
    this.phase = "error";
    this.emit("error", { phase: "error", text: this.apiKey ? text.replaceAll(this.apiKey, "[redacted]") : text });
  }

  private emit(kind: RunEvent["kind"], extra: Partial<RunEvent>): void {
    const event: RunEvent = {
      runtimeId: this.id,
      runId: this.runId,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      source: "Codex",
      kind,
      ...extra,
    };
    for (const listener of this.listeners) listener(event);
  }
}
