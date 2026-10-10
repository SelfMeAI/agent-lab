import { createPatch } from "diff";
import type { RemoteFailure, RemoteItem, RemoteTaskStatus } from "../../contracts/src/remote-agent";

export type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
export function text(value: unknown): string { return typeof value === "string" ? value : ""; }
export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part => text(record(part).text) || text(record(part).content)).filter(Boolean).join("\n");
}
export function timestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) { const date = new Date(value); return Number.isNaN(date.getTime()) ? undefined : date.toISOString(); }
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : value + "Z");
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
export function taskStatus(value: unknown): RemoteTaskStatus {
  const state = text(value).toLowerCase();
  if (/running|busy/.test(state)) return "running";
  if (/awaiting|waiting|blocked/.test(state)) return "waiting";
  if (/paused|interrupted|killed/.test(state)) return "paused";
  if (/finished|done|completed/.test(state)) return "completed";
  if (/error|failed|timeout|stuck/.test(state)) return "error";
  return "idle";
}
export function executionFailure(message: string, at?: string, runId?: string): RemoteFailure {
  const clean = message.replace(/\bsk-[a-zA-Z0-9_-]{10,}/g, "[已隐藏]")
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]+/gi, "Bearer [已隐藏]")
    .replace(/((?:"?(?:api[_ -]?key|authorization|token|password)"?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[已隐藏]");
  return { message: clean.slice(0, 12_000), at, runId };
}
export function toolInput(value: unknown): string {
  const args = record(value);
  const operation = text(args.command);
  const command = !["view", "create", "str_replace", "insert", "undo_edit"].includes(operation) ? operation || text(args.cmd) || text(args.url) : "";
  if (command) return command;
  const path = text(args.path) || text(args.file_path) || text(args.filePath);
  const edit = text(args.file_text) || text(args.new_str) || text(args.content);
  if (edit) return [path, edit].filter(Boolean).join("\n");
  if (path) return path;
  return Object.entries(args).filter(([key, value]) => typeof value === "string" && !/api_key|token|secret|password|kind/.test(key)).map(([key, value]) => `${key}: ${value}`).join("\n").slice(0, 20_000);
}
export function toolDiff(value: unknown): string | undefined {
  const args = record(value), path = text(args.path) || text(args.file_path) || "file";
  if (typeof args.old_str === "string" && typeof args.new_str === "string") return createPatch(path, args.old_str, args.new_str);
  if (typeof args.old_string === "string" && typeof args.new_string === "string") return createPatch(path, args.old_string, args.new_string);
  if (args.command === "create" && typeof args.file_text === "string") return createPatch(path, "", args.file_text);
  // A write body alone is not proof that the previous file was empty.
  if (args.prev_exist === false && typeof args.content === "string") return createPatch(path, "", args.content);
  if (typeof args.old_content === "string" && typeof args.new_content === "string") return createPatch(path, args.old_content, args.new_content);
  if (args.prev_exist === false && typeof args.new_content === "string") return createPatch(path, "", args.new_content);
  return undefined;
}
export function actionTitle(name: string, args: RecordValue, summary?: unknown): string {
  const path = text(args.path) || text(args.file_path) || text(args.filePath);
  const verb = /file|write|edit|patch/.test(name) ? args.command === "view" || name === "read" ? "读取文件" : args.command === "create" || /write/.test(name) ? "创建文件" : "编辑文件" : toolTitle(name);
  if (path) return `${verb} · ${path.split("/").pop()}`;
  const hint = text(summary);
  return hint && hint.length < 180 && !hint.includes("{\"") && !hint.startsWith(name + ":") ? hint : verb;
}
export function toolTitle(name: string): string {
  if (/browser/.test(name)) return "浏览器操作";
  if (/computer|screen/.test(name)) return "桌面操作";
  if (/write|edit|patch/.test(name)) return "编辑文件";
  if (/read|view|file/.test(name)) return "读取文件";
  if (/exec|terminal|bash|shell/.test(name)) return "执行命令";
  if (/search|grep|glob/.test(name)) return "搜索内容";
  if (/task|plan/.test(name)) return "更新计划";
  return name.replaceAll("_", " ");
}
export function clawToolCall(name: string, args: RecordValue): { name: string; args: RecordValue } {
  if (name !== "tool_call" || !text(args.id)) return { name, args };
  return { name: text(args.id).split(":").pop() || name, args: record(args.arguments ?? args.args) };
}
/** Normalize only user-facing fields. Never forward a native full state/config. */
export function openHandsItem(event: unknown): RemoteItem | undefined {
  const e = record(event), kind = text(e.kind), at = timestamp(e.timestamp), id = text(e.id);
  if (!id) return undefined;
  if (kind === "MessageEvent") { const msg = record(e.llm_message); return { id, at, role: msg.role === "user" || e.source === "user" ? "user" : "assistant", text: contentText(msg.content), reasoning: text(msg.reasoning_content) || undefined }; }
  if (kind === "ActionEvent") {
    const action = record(e.action); const name = text(e.tool_name);
    return { id, at, role: "tool", text: contentText(e.thought), reasoning: text(e.reasoning_content) || undefined,
      tool: { name, title: actionTitle(name, action, e.summary), input: toolInput(action), status: "running", diff: toolDiff(action), path: text(action.path) || undefined, startedAt: at, callId: text(e.tool_call_id) || undefined } };
  }
  if (kind === "ConversationErrorEvent") return { id, at, role: "notice", text: "", failure: executionFailure(text(e.detail) || text(e.error) || text(e.message), at) };
  if (/ErrorEvent/.test(kind)) return { id, at, role: "notice", text: text(e.detail) || text(e.error) || text(e.message) || "远端执行发生错误" };
  return undefined;
}
export function applyOpenHandsEvent(items: RemoteItem[], event: unknown): RemoteItem[] {
  const e = record(event), kind = text(e.kind), id = text(e.id);
  if (kind === "AgentErrorEvent" && text(e.tool_call_id) && items.some(item => item.tool?.callId === e.tool_call_id)) {
    return items.map(item => item.tool && item.tool.callId === e.tool_call_id ? { ...item, tool: { ...item.tool, output: text(e.error), status: "failed", endedAt: timestamp(e.timestamp) } } : item);
  }
  const item = openHandsItem(event);
  if (item) { const index = items.findIndex(entry => entry.id === id); if (index < 0) return [...items, item]; return items.map((entry, i) => i === index ? { ...item, streaming: false } : entry); }
  if (/ObservationEvent|UserRejectObservation/.test(kind)) {
    const action = text(e.action_id); const observation = record(e.observation);
    return items.map(entry => entry.id === action && entry.tool ? { ...entry, tool: { ...entry.tool, output: text(e.rejection_reason) || contentText(observation.content) || text(observation.text), status: /Reject/.test(kind) ? "rejected" : observation.is_error ? "failed" : "completed", endedAt: timestamp(e.timestamp), diff: text(observation.diff) || toolDiff(observation) || entry.tool.diff } } : entry);
  }
  return items;
}
export function openClawMessage(value: unknown, fallbackId: string): RemoteItem | undefined {
  const envelope = record(value), msg = record(envelope.message ?? value);
  const role = text(msg.role); const id = text(envelope.id) || text(envelope.messageId) || text(msg.id) || fallbackId;
  const at = timestamp(msg.timestamp ?? envelope.timestamp);
  if (role === "toolResult" || role === "tool") return { id, at, role: "tool", text: "", tool: { name: text(msg.toolName), title: toolTitle(text(msg.toolName)), input: "", output: contentText(msg.content), status: msg.isError ? "failed" : "completed" } };
  if (!["user", "assistant"].includes(role)) return undefined;
  const visible = contentText(msg.content) || text(msg.text);
  const parts = Array.isArray(msg.content) ? msg.content.map(record) : [];
  return { id, at, role: role as "user" | "assistant", text: role === "assistant" && msg.stopReason === "error" && visible === text(msg.errorMessage) ? "" : visible,
    reasoning: parts.filter(part => part.type === "thinking").map(part => text(part.thinking)).join("\n") || undefined,
    ...(role === "assistant" && msg.stopReason === "error" ? { failure: executionFailure(text(msg.errorMessage), at, text(record(msg.__openclaw).runId) || undefined) } : {}) };
}
