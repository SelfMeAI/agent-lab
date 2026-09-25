import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, dirname, sep } from "node:path";
import type { AgentSession, AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunEvent, RuntimePhase, RuntimeStatus } from "../../contracts/src/index";
import type { HarnessAdapter } from "./index";
import { FileChangeTracker } from "./file-change-tracker";

type JsonObject = Record<string, unknown>;
type ApprovalDecision = "allow_once" | "allow_session" | "deny";

export interface PiProvider {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface PiAdapterOptions {
  homeDirectory: string;
  provider(): Promise<PiProvider>;
}

interface PendingApproval {
  resolve(decision: ApprovalDecision): void;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function resultText(value: unknown): string | undefined {
  const content = object(value).content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.map((item) => object(item).text).filter((item): item is string => typeof item === "string" && Boolean(item));
  return parts.length ? parts.join("\n") : undefined;
}

function within(workspace: string, path: string): boolean {
  const offset = relative(workspace, path);
  return offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

// Pass only the checked absolute path to Pi's tools. Pi also interprets ~, @
// and file: URLs, so checking a raw argument but executing it unchanged is unsafe.
export async function resolveWorkspacePath(workspace: string, rawPath: string, mustExist = false): Promise<string> {
  const requested = resolve(workspace, rawPath);
  if (!within(workspace, requested)) throw new Error("Pi 文件工具仅能访问当前工作目录");
  let ancestor = requested;
  for (;;) {
    try {
      const actual = await realpath(ancestor);
      if (!within(workspace, actual)) throw new Error("Pi 文件工具不能通过符号链接离开工作目录");
      return ancestor === requested ? actual : join(actual, relative(ancestor, requested));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || mustExist) throw error;
      // A dangling symlink may point outside the workspace once its target is
      // created. Do not treat it as an ordinary missing path.
      try {
        if ((await lstat(ancestor)).isSymbolicLink()) throw new Error("Pi 文件工具不能写入悬空符号链接");
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export class PiAdapter implements HarnessAdapter {
  readonly id = "pi";
  readonly label = "Pi";
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly allowedForSession = new Set<string>();
  private readonly toolInputs = new Map<string, { name: string; args: JsonObject }>();
  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private fileTracker: FileChangeTracker | null = null;
  private workspace: string | null = null;
  private startPromise: Promise<void> | null = null;
  private phase: RuntimePhase = "idle";
  private sequence = 0;
  private runId = "session";
  private messageHadDelta = false;
  private apiKey: string | null = null;
  private sessionFile: string | null = null;

  constructor(private readonly options: PiAdapterOptions) {}

  async probe(): Promise<RuntimeStatus> {
    try {
      await import("@earendil-works/pi-coding-agent");
      return { id: this.id, label: this.label, availability: "ready", detail: "随应用安装的 Pi SDK" };
    } catch {
      return { id: this.id, label: this.label, availability: "missing", detail: "Pi SDK 尚未安装" };
    }
  }

  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isBusy(): boolean {
    return ["starting", "running", "approval", "cancelling"].includes(this.phase);
  }

  getResumeRef(): string | null { return this.sessionFile; }

  async start(workspace: string, resumeRef?: string): Promise<void> {
    const canonical = await realpath(workspace);
    if (!(await stat(canonical)).isDirectory()) throw new Error("工作目录必须是文件夹");
    if (this.session && this.workspace === canonical && ["ready", "running", "approval"].includes(this.phase)) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.boot(canonical, resumeRef);
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  private async boot(workspace: string, resumeRef?: string): Promise<void> {
    if (this.session) await this.stop();
    this.emitStatus("starting", "正在启动 Pi");
    await mkdir(this.options.homeDirectory, { recursive: true, mode: 0o700 });
    const provider = await this.options.provider();
    this.apiKey = provider.apiKey;
    try {
      const sdk = await import("@earendil-works/pi-coding-agent");
      const modelRuntime = await sdk.ModelRuntime.create({
        authPath: join(this.options.homeDirectory, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      modelRuntime.registerProvider("deepseek", { baseUrl: provider.baseUrl, apiKey: provider.apiKey });
      const selected = modelRuntime.getModel("deepseek", provider.model);
      const template = modelRuntime.getModel("deepseek", "deepseek-v4-pro") ?? modelRuntime.getModels("deepseek")[0];
      if (!template) throw new Error("Pi 缺少 DeepSeek 模型定义");
      const model = selected ?? { ...template, id: provider.model, name: provider.model };
      const settingsManager = sdk.SettingsManager.create(workspace, this.options.homeDirectory);
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: workspace,
        agentDir: this.options.homeDirectory,
        settingsManager,
        noExtensions: true,
      });
      await resourceLoader.reload();

      const read = sdk.createReadToolDefinition(workspace);
      const bash = sdk.createBashToolDefinition(workspace);
      const edit = sdk.createEditToolDefinition(workspace);
      const write = sdk.createWriteToolDefinition(workspace);
      const customTools = [
        { ...read, execute: async (id: string, params: Parameters<typeof read.execute>[1], signal: Parameters<typeof read.execute>[2], onUpdate: Parameters<typeof read.execute>[3], ctx: Parameters<typeof read.execute>[4]) => {
          const path = await resolveWorkspacePath(workspace, params.path, true);
          return read.execute(id, { ...params, path }, signal, onUpdate, ctx);
        } },
        { ...bash, execute: async (id: string, params: Parameters<typeof bash.execute>[1], signal: Parameters<typeof bash.execute>[2], onUpdate: Parameters<typeof bash.execute>[3], ctx: Parameters<typeof bash.execute>[4]) => {
          await this.requireApproval(id, "bash", params.command, signal);
          return bash.execute(id, params, signal, onUpdate, ctx);
        } },
        { ...edit, execute: async (id: string, params: Parameters<typeof edit.execute>[1], signal: Parameters<typeof edit.execute>[2], onUpdate: Parameters<typeof edit.execute>[3], ctx: Parameters<typeof edit.execute>[4]) => {
          const path = await resolveWorkspacePath(workspace, params.path, true);
          await this.requireApproval(id, "edit", params.path, signal);
          return edit.execute(id, { ...params, path }, signal, onUpdate, ctx);
        } },
        { ...write, execute: async (id: string, params: Parameters<typeof write.execute>[1], signal: Parameters<typeof write.execute>[2], onUpdate: Parameters<typeof write.execute>[3], ctx: Parameters<typeof write.execute>[4]) => {
          const path = await resolveWorkspacePath(workspace, params.path);
          await this.requireApproval(id, "write", params.path, signal);
          return write.execute(id, { ...params, path }, signal, onUpdate, ctx);
        } },
      ];
      const { session } = await sdk.createAgentSession({
        cwd: workspace,
        agentDir: this.options.homeDirectory,
        modelRuntime,
        model,
        thinkingLevel: model.reasoning ? "medium" : "off",
        sessionManager: resumeRef
          ? sdk.SessionManager.open(resumeRef, join(this.options.homeDirectory, "sessions"), workspace)
          : sdk.SessionManager.create(workspace, join(this.options.homeDirectory, "sessions")),
        settingsManager,
        resourceLoader,
        tools: ["read", "bash", "edit", "write"],
        customTools: customTools as unknown as ToolDefinition[],
      });
      this.session = session;
      this.sessionFile = session.sessionFile ?? null;
      this.workspace = workspace;
      this.fileTracker = new FileChangeTracker(workspace);
      this.allowedForSession.clear();
      this.toolInputs.clear();
      this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
      this.emitStatus("ready", "Pi 已就绪");
    } catch (error) {
      this.emitError(error instanceof Error ? error.message : String(error));
      await this.stop();
      throw error;
    }
  }

  async send(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (!text) throw new Error("请输入任务内容");
    const session = this.session;
    if (!session || this.phase !== "ready") throw new Error("Pi 尚未就绪，或正在执行上一轮任务");
    this.runId = randomUUID();
    this.emitStatus("running", "Pi 正在执行任务");
    void session.prompt(text).then(() => {
      if (session !== this.session || this.phase === "error") return;
      this.emitStatus("ready", this.phase === "cancelling" ? "本轮已取消" : "本轮已完成");
    }).catch((error: unknown) => {
      if (session === this.session && this.phase !== "idle") this.emitError(error instanceof Error ? error.message : String(error));
    });
  }

  async cancel(): Promise<void> {
    const session = this.session;
    if (!session || !["running", "approval"].includes(this.phase)) return;
    this.emitStatus("cancelling", "正在取消 Pi 任务");
    this.denyApprovals();
    await session.abort();
    if (session === this.session && this.phase === "cancelling") this.emitStatus("ready", "本轮已取消");
  }

  async respondApproval(requestId: string | number, optionId: string): Promise<void> {
    if (optionId !== "allow_once" && optionId !== "allow_session" && optionId !== "deny") throw new Error("无效的审批选项");
    const pending = this.approvals.get(String(requestId));
    if (!pending) throw new Error("审批请求已失效");
    pending.resolve(optionId);
    this.emitStatus("running", optionId === "deny" ? "已拒绝操作，Pi 将继续处理" : "审批已提交，继续执行");
  }

  async stop(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.sessionFile = null;
    this.workspace = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.denyApprovals();
    this.allowedForSession.clear();
    this.toolInputs.clear();
    this.fileTracker?.clear();
    this.fileTracker = null;
    if (session) {
      try { await session.abort(); } catch { /* Already idle or disposed. */ }
      session.dispose();
    }
    this.apiKey = null;
    this.emitStatus("idle", "Pi 已停止");
  }

  private requireApproval(toolCallId: string, toolName: string, detail: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("操作已取消"));
    if (this.allowedForSession.has(toolName)) return Promise.resolve();
    const requestId = randomUUID();
    const title = toolName === "bash" ? "命令执行授权" : "文件修改授权";
    return new Promise<void>((resolveApproval, rejectApproval) => {
      const finish = (decision: ApprovalDecision): void => {
        signal?.removeEventListener("abort", abort);
        this.approvals.delete(requestId);
        if (decision === "allow_session") this.allowedForSession.add(toolName);
        if (decision === "deny" || signal?.aborted) rejectApproval(new Error("用户已拒绝或取消此操作"));
        else resolveApproval();
      };
      const abort = (): void => finish("deny");
      this.approvals.set(requestId, { resolve: finish });
      signal?.addEventListener("abort", abort, { once: true });
      this.emitStatus("approval", "等待你的审批");
      this.emit("approval", {
        title,
        text: detail,
        approval: {
          requestId,
          title,
          toolCallId,
          options: [
            { optionId: "allow_once", name: "允许一次", kind: "allow" },
            { optionId: "allow_session", name: "本会话同类操作始终允许", kind: "allow_session" },
            { optionId: "deny", name: "拒绝", kind: "reject" },
          ],
        },
      });
    });
  }

  private denyApprovals(): void {
    for (const pending of [...this.approvals.values()]) pending.resolve("deny");
    this.approvals.clear();
  }

  private handleEvent(event: AgentSessionEvent): void {
    if (event.type === "message_start") this.messageHadDelta = false;
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" && update.delta) {
        this.messageHadDelta = true;
        this.emit("message", { text: update.delta });
      } else if (update.type === "thinking_delta" && update.delta) {
        this.emit("thought", { text: update.delta });
      }
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      if (!this.messageHadDelta) {
        const text = event.message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        if (text) this.emit("message", { text });
      }
      if (event.message.stopReason === "error") this.emitError(event.message.errorMessage ?? "Pi 模型请求失败");
      return;
    }
    if (event.type === "tool_execution_start") {
      const args = object(event.args);
      this.toolInputs.set(event.toolCallId, { name: event.toolName, args });
      if (event.toolName === "read" || event.toolName === "edit" || event.toolName === "write") {
        this.fileTracker?.start(event.toolCallId, event.toolName, { file_path: args.path });
      }
      this.emit("tool", {
        title: event.toolName,
        toolCallId: event.toolCallId,
        toolStatus: "running",
        raw: { kind: event.toolName, rawInput: { ...args, file_path: args.path }, command: args.command, cwd: this.workspace },
      });
      return;
    }
    if (event.type === "tool_execution_update") {
      const text = resultText(event.partialResult);
      if (text) this.emit("tool", { toolCallId: event.toolCallId, toolStatus: "running", text });
      return;
    }
    if (event.type === "tool_execution_end") {
      const input = this.toolInputs.get(event.toolCallId);
      this.toolInputs.delete(event.toolCallId);
      const diff = this.fileTracker?.finish(event.toolCallId, !event.isError);
      const rawOutput = resultText(event.result);
      this.emit("tool", {
        title: event.toolName,
        toolCallId: event.toolCallId,
        toolStatus: event.isError ? "failed" : "completed",
        text: rawOutput,
        raw: {
          kind: event.toolName,
          rawInput: input ? { ...input.args, file_path: input.args.path } : {},
          command: input?.args.command,
          cwd: this.workspace,
          rawOutput,
          ...(diff ? { content: [diff] } : {}),
        },
      });
      return;
    }
    if (event.type === "compaction_start") this.emit("status", { title: "正在压缩上下文", text: event.reason });
    if (event.type === "compaction_end") this.emit("status", { title: "上下文压缩结束", text: event.aborted ? "已中断" : "已完成" });
    if (event.type === "auto_retry_start") this.emit("status", { title: "模型请求重试", text: `第 ${event.attempt} / ${event.maxAttempts} 次` });
  }

  private emitStatus(phase: RuntimePhase, text: string): void {
    this.phase = phase;
    this.emit("status", { phase, text });
  }

  private emitError(text: string): void {
    this.phase = "error";
    this.emit("error", { phase: "error", text: this.apiKey ? text.replaceAll(this.apiKey, "[redacted]") : text });
  }

  private emit(kind: RunEvent["kind"], extra: Partial<RunEvent>): void {
    const event: RunEvent = {
      runtimeId: this.id,
      runId: this.runId,
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      source: "Pi",
      kind,
      ...extra,
    };
    for (const listener of this.listeners) listener(event);
  }
}
