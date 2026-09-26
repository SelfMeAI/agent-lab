import type { ServerResponse } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export type Obj = Record<string, any>;

/** Keep deterministic tests focused on the active turn, not hidden memory jobs. */
export function prepareQwenTestHome(homeDirectory: string): string {
  mkdirSync(homeDirectory, { recursive: true });
  const path = join(homeDirectory, "settings.json");
  if (!existsSync(path)) writeFileSync(path, JSON.stringify({ memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false } }));
  return homeDirectory;
}

export function chat(res: ServerResponse, tool?: { name: string; args: Obj }, text?: string) {
  const id = `chatcmpl-${Date.now()}`;
  const chunk = (delta: Obj, reason: string | null = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  chunk({ role: "assistant" });
  if (tool) chunk({ tool_calls: [{ index: 0, id: `call-${id}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
  else chunk({ content: text ?? "done" });
  chunk({}, tool ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
}

export function responses(res: ServerResponse, tool?: { name: string; args: Obj }, text?: string) {
  const id = `resp-${Date.now()}`;
  const emit = (type: string, extra: Obj) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
  const item = tool ? { type: "function_call", id: "fc_sleep", call_id: "call_sleep", name: tool.name, arguments: JSON.stringify(tool.args), status: "completed" }
    : { type: "message", id: "msg_final", role: "assistant", status: "completed", content: [{ type: "output_text", text: text ?? "done", annotations: [] }] };
  res.writeHead(200, { "content-type": "text/event-stream" });
  emit("response.created", { response: { id, status: "in_progress", output: [] } });
  emit("response.output_item.added", { output_index: 0, item: { ...item, ...(tool ? { arguments: "" } : { content: [] }) } });
  if (tool) {
    emit("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: JSON.stringify(tool.args) });
    emit("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: JSON.stringify(tool.args) });
  } else {
    emit("response.content_part.added", { output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    emit("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: text ?? "done" });
    emit("response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text: text ?? "done" });
  }
  emit("response.output_item.done", { output_index: 0, item });
  emit("response.completed", { response: { id, status: "completed", output: [item], usage: { input_tokens: 25, output_tokens: 12, total_tokens: 37 } } });
  res.end();
}

export function shellTool(body: Obj): { name: string; args: Obj } {
  const tools = (body.tools ?? []).map((entry: Obj) => entry.function ?? entry);
  const tool = tools.find((entry: Obj) => /^(bash|shell|exec_command)$/i.test(entry.name))
    ?? tools.find((entry: Obj) => /bash|shell|execute.*command/i.test(entry.name));
  if (!tool) throw new Error(`No shell tool: ${tools.map((entry: Obj) => entry.name).join(",")}`);
  const props = tool.parameters?.properties ?? {};
  const args: Obj = {};
  if (props.cmd) args.cmd = "sleep 2";
  else if (props.command?.type === "array") args.command = ["/bin/sleep", "2"];
  else args.command = "sleep 2";
  // Qwen correctly rejects purposeless sleeps. Here pacing is intentional:
  // hold the real tool boundary open so we can exercise mid-turn admission.
  if (tool.name === "run_shell_command") args.command = "sleep 2 # intentional-sleep: exercise ACP mid-turn input boundary";
  if (props.description) args.description = "Steering integration check";
  return { name: tool.name, args };
}
