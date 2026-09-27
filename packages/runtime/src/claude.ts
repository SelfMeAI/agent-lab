import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import type { CanUseTool, Options, PermissionResult, PermissionUpdate, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentQuestionAnswers, ApprovalRequest, RunEvent, RuntimePhase, RuntimeStatus } from "../../contracts/src/index";
import type { HarnessAdapter } from "./index";
import { ClaudeInput } from "./claude-input";
import { FileChangeTracker } from "./file-change-tracker";
import { claudeQuestions, validateQuestionAnswers } from "./user-questions";
import { SteeringTracker, steeringError } from "./steering";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const toolKind = (name: string): string => ({ Read: "read", Edit: "edit", Write: "write", Bash: "bash", Glob: "search", Grep: "search", WebSearch: "search", WebFetch: "fetch" })[name] ?? name;
const toolLabel = (name: string): string => ({ Read: "读取文件", Edit: "修改文件", Write: "写入文件", Bash: "执行命令", Glob: "查找文件", Grep: "搜索内容", AskUserQuestion: "向你提问", ExitPlanMode: "确认计划", Agent: "执行子任务", Task: "执行子任务", WebSearch: "网页搜索", WebFetch: "读取网页" })[name] ?? name;

export interface ClaudeProvider { baseUrl: string; model: string; apiKey: string }
export interface ClaudeAdapterOptions {
  executable: string;
  homeDirectory: string;
  provider(): Promise<ClaudeProvider>;
}
interface PendingApproval {
  request: ApprovalRequest;
  input: Obj;
  suggestions: PermissionUpdate[];
  settle(result: PermissionResult): void;
}
interface ToolCall { name: string; input: Obj; startedAt: number; completed?: boolean }

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = "claude-code";
  readonly label = "Claude Agent";
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly tools = new Map<string, ToolCall>();
  private readonly steering = new SteeringTracker(extra => this.emit("delivery", extra));
  private readonly steeringIds = new Map<string, string>();
  private readonly streamedBlocks = new Set<string>();
  private readonly completeBlockIndices = new Map<string, number>();
  private query: Query | null = null;
  private input: ClaudeInput | null = null;
  private pump: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private workspace: string | null = null;
  private nativeRef: string | null = null;
  private tracker: FileChangeTracker | null = null;
  private apiKey = "";
  private phase: RuntimePhase = "idle";
  private sequence = 0;
  private runId = "session";
  private hasAssistantText = false;
  private readonly streamMessageIds = new Map<string, string>();
  private backgroundTasks = new Set<string>();
  private turnFinished = false;
  private nativeQueuedTurns = 0;

  constructor(private readonly options: ClaudeAdapterOptions) {}
  onEvent(listener: (event: RunEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getResumeRef(): string | null { return this.nativeRef; }

  async probe(): Promise<RuntimeStatus> {
    try {
      await access(this.options.executable);
      await import("@anthropic-ai/claude-agent-sdk");
      return { id: this.id, label: this.label, availability: "ready", detail: "官方 Claude Agent SDK 与随应用打包的运行时" };
    } catch { return { id: this.id, label: this.label, availability: "missing", detail: "Claude 官方运行时尚未安装" }; }
  }

  async start(workspace: string, resumeRef?: string): Promise<void> {
    const canonical = await realpath(workspace);
    if (!(await stat(canonical)).isDirectory()) throw new Error("工作目录必须是文件夹");
    if (this.query && canonical === this.workspace && ["ready", "running", "approval"].includes(this.phase)) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.boot(canonical, resumeRef);
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  private async boot(workspace: string, resumeRef?: string): Promise<void> {
    await this.closeNative();
    this.status("starting", "正在连接 Claude");
    await mkdir(this.options.homeDirectory, { recursive: true, mode: 0o700 });
    const provider = await this.options.provider();
    this.apiKey = provider.apiKey;
    this.workspace = workspace;
    this.nativeRef = resumeRef ?? randomUUID();
    this.tracker = new FileChangeTracker(workspace);
    this.tools.clear(); this.streamedBlocks.clear(); this.streamMessageIds.clear(); this.steeringIds.clear(); this.backgroundTasks.clear();
    this.turnFinished = false; this.nativeQueuedTurns = 0;
    const input = new ClaudeInput();
    this.input = input;
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    // Never mutate global process.env: parallel sessions and other harnesses
    // must not inherit Claude credentials or one another's config directories.
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/^(?:ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CLAUDE_AGENT_SDK_)/.test(name)) delete env[name];
    }
    // Anthropic's client appends /v1/messages itself. Accept either a root or
    // a user-entered trailing /v1 without producing /v1/v1/messages.
    const apiRoot = provider.baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
    const connection = { ANTHROPIC_BASE_URL: apiRoot, ANTHROPIC_AUTH_TOKEN: provider.apiKey };
    const options: Options = {
      cwd: workspace,
      pathToClaudeCodeExecutable: this.options.executable,
      ...(resumeRef ? { resume: resumeRef } : { sessionId: this.nativeRef }),
      model: provider.model,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project", "local"],
      permissionMode: "default",
      includePartialMessages: true,
      forwardSubagentText: true,
      env: { ...env, ...connection, CLAUDE_CONFIG_DIR: this.options.homeDirectory, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      // Pin routing in the highest user settings layer; keep the credential
      // only in the process environment, never in CLI arguments or files.
      settings: { env: { ANTHROPIC_BASE_URL: apiRoot } },
      extraArgs: { "replay-user-messages": null },
      canUseTool: (name, args, context) => this.requireApproval(name, args, context),
      hooks: {
        PreToolUse: [{ hooks: [async (value, id) => {
          const event = object(value);
          if (id) this.beginTool(id, text(event.tool_name), object(event.tool_input));
          return {};
        }] }],
        PostToolUse: [{ hooks: [async (value, id) => {
          const event = object(value);
          if (id) this.finishTool(id, event.tool_response, false);
          return {};
        }] }],
        PostToolUseFailure: [{ hooks: [async (value, id) => {
          if (id) this.finishTool(id, object(value).error, true);
          return {};
        }] }],
      },
      stderr: () => {}, // Native debug output can contain credentials; not a user transcript.
    };
    const query = sdk.query({ prompt: input, options });
    this.query = query;
    this.pump = this.consume(query);
    try {
      await this.deadline(query.initializationResult(), 20000, "Claude 启动超时");
      if (this.query !== query || this.phase === "error") throw new Error("Claude 启动失败");
      this.status("ready", "Claude 已就绪");
    } catch (error) {
      await this.closeNative();
      this.fail(error);
      throw steeringError(error, this.apiKey);
    }
  }

  async send(prompt: string): Promise<void> {
    const value = prompt.trim();
    if (!value) throw new Error("请输入任务内容");
    if (this.phase !== "ready" || !this.workspace) throw new Error("Claude 尚未就绪，或正在执行上一轮任务");
    // Stop tears down the native process so unsent native messages cannot run
    // after cancellation. The next prompt resumes the persisted conversation.
    if (!this.query) await this.boot(this.workspace, this.nativeRef ?? undefined);
    this.runId = randomUUID(); this.hasAssistantText = false;
    this.streamedBlocks.clear(); this.streamMessageIds.clear(); this.completeBlockIndices.clear(); this.tools.clear();
    this.turnFinished = false; this.nativeQueuedTurns = 0;
    this.status("running", "Claude 正在执行任务");
    this.input!.push(this.userMessage(value, randomUUID()));
  }

  async steer(prompt: string, messageId: string): Promise<void> {
    if (!this.query || !this.input || !["running", "approval"].includes(this.phase)) throw new Error("本轮已结束，补充指令未提交");
    const value = this.steering.begin(messageId, prompt);
    const uuid = randomUUID();
    this.steeringIds.set(uuid, messageId);
    try {
      // Native streaming input folds these messages into the active loop at
      // its tool boundary. Do NOT interrupt/restart and call that steering.
      // "now" aborts the running tool and starts another native turn;
      // "next" instead folds input at the next tool boundary in this turn.
      this.input.push(this.userMessage(value, uuid, "next"));
      this.steering.accepted(messageId);
    } catch (error) {
      this.steeringIds.delete(uuid);
      this.steering.rejected(messageId, error);
      throw steeringError(error, this.apiKey);
    }
  }

  private userMessage(content: string, uuid: ReturnType<typeof randomUUID>, priority?: SDKUserMessage["priority"]): SDKUserMessage {
    return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid, ...(priority ? { priority } : {}) };
  }

  async cancel(): Promise<void> {
    const query = this.query;
    if (!query || !["running", "approval"].includes(this.phase)) return;
    this.status("cancelling", "正在取消 Claude 任务");
    this.expireApprovals();
    try { await this.deadline(query.interrupt(), 5000, "Claude 取消请求超时"); }
    catch { /* Closing the official process is the fail-closed fallback. */ }
    await this.closeNative();
    this.status("ready", "本轮已取消");
  }

  async stop(): Promise<void> { await this.closeNative(); this.status("idle", "Claude 已停止"); }

  private async closeNative(): Promise<void> {
    const query = this.query, pump = this.pump;
    this.query = null; this.pump = null;
    this.expireApprovals();
    this.steering.finish("运行已停止，未确认接入的补充不会自动执行");
    this.steeringIds.clear();
    this.input?.close(); this.input = null;
    query?.close();
    if (query) { try { await this.deadline(query.return(), 5000, "Claude 退出超时"); } catch { /* close() already terminates the child. */ } }
    if (pump) { try { await this.deadline(pump, 5000, "Claude 消息流退出超时"); } catch { /* The session has already been detached. */ } }
    this.tracker?.clear();
  }

  async respondApproval(requestId: string | number, optionId: string, answers?: AgentQuestionAnswers): Promise<void> {
    const pending = this.approvals.get(String(requestId));
    if (!pending) throw new Error("审批已失效或不属于当前会话");
    if (!pending.request.options.some(option => option.optionId === optionId)) throw new Error("无效的审批选项");
    let result: PermissionResult;
    if (pending.request.questions !== undefined) {
      if (optionId === "cancel") result = { behavior: "deny", message: "用户取消了本次提问" };
      else {
        const values = validateQuestionAnswers(pending.request.questions, answers);
        const nativeAnswers: Record<string, string> = Object.create(null);
        for (const question of pending.request.questions) nativeAnswers[question.question] = values[question.id].join(", ");
        result = { behavior: "allow", updatedInput: { ...pending.input, answers: nativeAnswers } };
      }
    } else {
      if (answers !== undefined) throw new Error("权限请求不接受问题答案");
      result = optionId === "deny" ? { behavior: "deny", message: "用户拒绝了本次操作" }
        : { behavior: "allow", updatedInput: pending.input,
          ...(optionId === "allow_session" ? { updatedPermissions: pending.suggestions.map(suggestion => ({ ...suggestion, destination: "session" })) } : {}) };
    }
    pending.settle(result);
  }

  private requireApproval: CanUseTool = (name, input, context) => {
    if (context.signal.aborted || !this.query) return Promise.resolve({ behavior: "deny", message: "运行已取消" });
    const questions = name === "AskUserQuestion" ? claudeQuestions(input.questions) : undefined;
    if (questions && !questions.length) return Promise.resolve({ behavior: "deny", message: "提问格式无效，请重新提问" });
    const requestId = context.requestId || randomUUID();
    const request: ApprovalRequest = {
      requestId, title: questions ? "需要你回答" : toolLabel(name), toolCallId: context.toolUseID,
      ...(questions ? { questions } : {}),
      options: questions ? [{ optionId: "submit", name: "提交答案", kind: "allow_once" }, { optionId: "cancel", name: "取消", kind: "reject_once" }]
        : [{ optionId: "allow_once", name: "允许一次", kind: "allow_once" },
          ...(!context.suppressAlwaysAllowRule && context.suggestions?.length ? [{ optionId: "allow_session", name: "本会话允许同类操作", kind: "allow_session" }] : []),
          { optionId: "deny", name: "拒绝", kind: "reject_once" }],
    };
    return new Promise<PermissionResult>(resolve => {
      const onAbort = () => settle({ behavior: "deny", message: "运行已取消" }, true);
      const settle = (result: PermissionResult, expired = false) => {
        if (!this.approvals.delete(requestId)) return;
        context.signal.removeEventListener("abort", onAbort);
        if (expired) this.emit("approval_result", { title: "请求已取消", text: "该请求已取消", approval: request });
        if (!this.approvals.size && this.phase === "approval") this.status("running", "Claude 正在继续工作");
        resolve(result);
      };
      this.approvals.set(requestId, { request, input, suggestions: context.suggestions ?? [], settle: result => settle(result) });
      context.signal.addEventListener("abort", onAbort, { once: true });
      this.status("approval", questions ? "等待你回答问题" : "等待你确认操作");
      const target = text(input.command) || text(input.file_path) || text(context.blockedPath) || text(input.plan);
      this.emit("approval", { approval: request, title: request.title, text: questions ? questions.map(q => q.question).join("\n") : `${toolLabel(name)}${target ? `：${target}` : ""}` });
      if (context.signal.aborted) onAbort();
    });
  };

  private expireApprovals(): void {
    for (const pending of [...this.approvals.values()]) {
      this.emit("approval_result", { title: "请求已取消", text: "该请求已取消", approval: pending.request });
      pending.settle({ behavior: "deny", message: "运行已取消" });
    }
  }

  private async consume(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        if (this.query !== query) break;
        this.handleMessage(message);
      }
      if (this.query === query && !["idle", "cancelling", "error"].includes(this.phase)) this.fail(new Error("Claude 运行时已退出，请重新发送任务连接"));
    } catch (error) { if (this.query === query) this.fail(error); }
  }

  private handleMessage(value: SDKMessage): void {
    const event = object(value);
    const uuids = Array.isArray(event.user_message_uuids) ? event.user_message_uuids : [event.user_message_uuid];
    for (const uuid of uuids) {
      const id = this.steeringIds.get(text(uuid));
      if (id) { this.steering.incorporated(id); this.steeringIds.delete(text(uuid)); }
    }
    if (event.type === "system" && event.subtype === "init") {
      if (event.session_id) this.nativeRef = text(event.session_id);
      return;
    }
    if (event.type === "stream_event") {
      const stream = object(event.event);
      const source = text(event.parent_tool_use_id);
      if (stream.type === "message_start") this.streamMessageIds.set(source, text(object(stream.message).id));
      if (stream.type === "content_block_delta") {
        const delta = object(stream.delta), key = `${this.streamMessageIds.get(source)}:${stream.index}`;
        if (delta.type === "text_delta" || delta.type === "thinking_delta") {
          const fragment = text(delta.text) || text(delta.thinking);
          if (fragment) {
            this.streamedBlocks.add(key);
            if (delta.type === "text_delta") this.hasAssistantText = true;
            this.emit(delta.type === "text_delta" ? "message" : "thought", { text: fragment });
          }
        }
      }
      return;
    }
    if (event.type === "assistant") {
      const message = object(event.message), blocks = message.content;
      if (!Array.isArray(blocks)) return;
      const messageId = text(message.id), firstIndex = this.completeBlockIndices.get(messageId) ?? 0;
      for (const [offset, item] of blocks.entries()) {
        const index = firstIndex + offset;
        const block = object(item);
        if (block.type === "tool_use") this.beginTool(text(block.id), text(block.name), object(block.input));
        else if ((block.type === "text" || block.type === "thinking") && !this.streamedBlocks.has(`${text(message.id)}:${index}`)) {
          const fragment = text(block.text) || text(block.thinking);
          if (fragment) { if (block.type === "text") this.hasAssistantText = true; this.emit(block.type === "text" ? "message" : "thought", { text: fragment }); }
        }
      }
      this.completeBlockIndices.set(messageId, firstIndex + blocks.length);
      return;
    }
    if (event.type === "user") {
      const content = object(event.message).content;
      if (Array.isArray(content)) for (const item of content) {
        const block = object(item);
        if (block.type === "tool_result") this.finishTool(text(block.tool_use_id), event.tool_use_result ?? block.content, block.is_error === true);
      }
      return;
    }
    if (event.type === "result") {
      if (this.phase === "cancelling") return;
      if (event.is_error || event.subtype !== "success") {
        this.fail(new Error(Array.isArray(event.errors) ? event.errors.map(text).join("\n") : text(event.result) || "Claude 执行失败"));
        return;
      }
      if (!this.hasAssistantText && text(event.result)) this.emit("message", { text: text(event.result) });
      this.turnFinished = true;
      this.nativeQueuedTurns = Number(event.queued_turn_count) || 0;
      this.finishIfIdle();
      return;
    }
    if (event.type === "system" && event.subtype === "compact_boundary") {
      this.emit("status", { title: "上下文已压缩", text: "Claude 已整理上下文，继续保留任务所需信息" });
    } else if (event.type === "system" && event.subtype === "background_tasks_changed") {
      const tasks = Array.isArray(event.tasks) ? event.tasks : Array.isArray(event.task_ids) ? event.task_ids : [];
      this.backgroundTasks = new Set(tasks.filter(item => object(item).ambient !== true).map(item => typeof item === "string" ? item : text(object(item).task_id)).filter(Boolean));
      this.finishIfIdle();
    } else if (event.type === "system" && event.subtype === "task_started") {
      if (event.ambient === true) return;
      this.backgroundTasks.add(text(event.task_id));
      this.emit("tool", { toolCallId: text(event.tool_use_id) || text(event.task_id), title: "后台任务", text: text(event.description), toolStatus: "in_progress" });
    } else if (event.type === "system" && event.subtype === "task_notification") {
      if (event.ambient === true) return;
      this.backgroundTasks.delete(text(event.task_id));
      this.emit("tool", { toolCallId: text(event.tool_use_id) || text(event.task_id), title: "后台任务", text: text(event.summary), toolStatus: event.status === "completed" ? "completed" : "failed" });
      this.finishIfIdle();
    } else if (event.type === "system" && event.subtype === "api_retry") {
      this.emit("status", { title: "正在重试连接", text: `模型服务暂时不可用，Claude 正在重试（${Number(event.attempt) || 1}）` });
    }
  }

  private finishIfIdle(): void {
    if (!this.turnFinished || this.nativeQueuedTurns || this.backgroundTasks.size || !["running", "approval"].includes(this.phase)) return;
    this.turnFinished = false;
    this.steering.finish(); this.steeringIds.clear();
    this.status("ready", "本轮已完成");
  }

  private beginTool(id: string, name: string, input: Obj): void {
    if (!id || this.tools.has(id)) return;
    this.tools.set(id, { name, input, startedAt: performance.now() });
    this.tracker?.start(id, toolKind(name), input);
    this.emit("tool", { toolCallId: id, title: name, text: text(input.description) || text(input.file_path) || text(input.command) || text(input.query), toolStatus: "in_progress",
      raw: { kind: toolKind(name), rawInput: input, cwd: this.workspace } });
  }

  private finishTool(id: string, result: unknown, failed: boolean): void {
    const call = this.tools.get(id);
    if (!call || call.completed) return;
    call.completed = true;
    const native = object(result);
    const blocks = (value: unknown) => Array.isArray(value) ? value.map(item => text(object(item).text)).filter(Boolean).join("\n") : text(value);
    const parts = typeof result === "string" ? result : Array.isArray(result) ? blocks(result)
      : [text(native.stdout), text(native.stderr), blocks(native.content), text(object(native.file).content),
        Array.isArray(native.filenames) ? native.filenames.map(text).join("\n") : ""].filter(Boolean).join("\n");
    const diff = this.tracker?.finish(id, !failed);
    this.emit("tool", { toolCallId: id, title: call.name, text: parts || (call.name === "AskUserQuestion" ? "已收到你的回答" : failed ? "操作未完成" : "操作已完成"), toolStatus: failed ? "failed" : "completed",
      raw: { kind: toolKind(call.name), rawInput: call.input, cwd: this.workspace, durationMs: performance.now() - call.startedAt,
        ...(typeof native.exitCode === "number" ? { exitCode: native.exitCode } : {}), ...(diff ? { content: [diff] } : {}) } });
  }

  private status(phase: RuntimePhase, message: string): void { this.phase = phase; this.emit("status", { phase, text: message }); }
  private fail(error: unknown): void {
    this.expireApprovals(); this.steering.finish("运行出错，未确认补充是否接入");
    const message = steeringError(error, this.apiKey).message;
    this.status("error", message); this.emit("error", { text: message });
  }
  private emit(kind: RunEvent["kind"], extra: Partial<RunEvent>): void {
    const event: RunEvent = { runtimeId: this.id, runId: this.runId, sequence: ++this.sequence, at: new Date().toISOString(), source: this.label, kind, ...extra };
    // Scrub every payload before it enters SQLite or the renderer.
    const safe = this.apiKey ? JSON.parse(JSON.stringify(event, (_key, value) => typeof value === "string" ? value.replaceAll(this.apiKey, "[redacted]") : value)) as RunEvent : event;
    for (const listener of this.listeners) listener(safe);
  }
  private async deadline<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
    finally { clearTimeout(timer!); }
  }
}
