import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../contracts/src/index";
import type { HarnessAdapter } from "./index";
import { CodexAdapter } from "./codex";
import { DshAdapter } from "./dsh";
import { PiAdapter } from "./pi";
import { KimiAdapter } from "./kimi";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runtimeRoot = process.env.SELFME_STEERING_RUNTIME_ROOT ?? join(root, "runtimes");
const nodeExecutable = process.env.SELFME_STEERING_NODE_EXECUTABLE ?? process.execPath;
const marker = "SELFME_MID_TURN_REQUIREMENT_731";
const secondMarker = "SELFME_SECOND_REQUIREMENT_942";
type Obj = Record<string, any>;

function chat(res: ServerResponse, tool?: { name: string; args: Obj }, text?: string) {
  const id = `chatcmpl-${Date.now()}`;
  const chunk = (delta: Obj, reason: string | null = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  chunk({ role: "assistant" });
  if (tool) chunk({ tool_calls: [{ index: 0, id: "call_sleep", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
  else chunk({ content: text ?? "done" });
  chunk({}, tool ? "tool_calls" : "stop");
  res.end("data: [DONE]\n\n");
}

function responses(res: ServerResponse, tool?: { name: string; args: Obj }, text?: string) {
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

function shellTool(body: Obj): { name: string; args: Obj } {
  const tools = (body.tools ?? []).map((entry: Obj) => entry.function ?? entry);
  const tool = tools.find((entry: Obj) => /^(bash|shell|exec_command)$/i.test(entry.name))
    ?? tools.find((entry: Obj) => /bash|shell|execute.*command/i.test(entry.name));
  if (!tool) throw new Error(`No shell tool: ${tools.map((entry: Obj) => entry.name).join(",")}`);
  const props = tool.parameters?.properties ?? {};
  const args: Obj = {};
  if (props.cmd) args.cmd = "sleep 2";
  else if (props.command?.type === "array") args.command = ["/bin/sleep", "2"];
  else args.command = "sleep 2";
  if (props.description) args.description = "Steering integration check";
  return { name: tool.name, args };
}

describe("real bundled harnesses: mid-turn steering", () => {
  // Native file watchers/process sandboxes need the normal host environment.
  const cases = (["codex", "dsh", "pi", "kimi-code"] as const).flatMap(id => [{ id, cancel: false }, { id, cancel: true }]);
  it.runIf(process.env.SELFME_STEERING_INTEGRATION === "1").each(cases)("$id mid-turn supplements (cancel=$cancel)", async ({ id, cancel }) => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/steering-check-"));
    const workspace = join(scratch, "workspace");
    await mkdir(workspace);
    const requests: Obj[] = [];
    let providerError: Error | undefined;
    let receivedInOriginalRun = false;
    let completed = false;
    let adapter: HarnessAdapter;
    const server = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        const body = JSON.parse(raw) as Obj;
        requests.push(body);
        if (requests.length > 5) throw new Error("Unexpected extra model requests");
        const input = JSON.stringify(body.messages ?? body.input);
        const hasMarker = input.includes(marker) && input.includes(secondMarker);
        if (hasMarker && !completed) receivedInOriginalRun = true;
        const respond = req.url?.includes("responses") ? responses : chat;
        if (requests.length === 1) respond(res, shellTool(body));
        else respond(res, undefined, hasMarker ? `已按补充要求执行：${marker}` : "missing-steering");
      } catch (error) {
        providerError = error as Error;
        res.writeHead(500); res.end(JSON.stringify({ error: { message: providerError.message } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const provider = async () => ({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "deepseek-v4-flash", apiKey: "sk-local-steering-check" });
    const homeDirectory = join(scratch, "home");
    if (id === "codex") adapter = new CodexAdapter({ homeDirectory, executable: join(runtimeRoot, "codex/bin/codex"), provider });
    else if (id === "pi") adapter = new PiAdapter({ homeDirectory, provider });
    else if (id === "dsh") adapter = new DshAdapter({ homeDirectory, provider, nodeExecutable, entryPoint: join(runtimeRoot, "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"), steeringLoader: join(runtimeRoot, "dsh/steering-loader.mjs") });
    else adapter = new KimiAdapter({ homeDirectory, provider, nodeExecutable, entryPoint: join(runtimeRoot, "kimi-code/node_modules/@moonshot-ai/kimi-code/dist/main.mjs"), steeringLoader: join(runtimeRoot, "kimi-code/steering-loader.mjs") });
    const events: RunEvent[] = [];
    let steered = false;
    let steeringCall: Promise<void> | undefined;
    const runEnded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Run timeout; ${JSON.stringify(events.map(e => ({ kind: e.kind, phase: e.phase, text: e.text?.slice(0, 160), title: e.title, delivery: e.deliveryState })))}`)), 25000);
      adapter.onEvent((event) => {
        events.push(event);
        if (!steered && (event.kind === "tool" || event.kind === "approval")) {
          steered = true;
          steeringCall = Promise.all([
            adapter.steer(`变更要求：最终回复必须包含 ${marker}`, "steering-test-1"),
            adapter.steer(`新增要求：还必须包含 ${secondMarker}`, "steering-test-2"),
          ]).then(async () => { if (cancel) await adapter.cancel(); });
          // Keep a rejection handler attached while still asserting below.
          void steeringCall.catch(() => {});
        }
        if (event.kind === "approval" && event.approval) {
          const option = event.approval.options.find(o => o.kind.includes("allow"));
          if (option) void adapter.respondApproval(event.approval.requestId, option.optionId).catch(reject);
        }
        if (steered && event.phase === "ready") { completed = true; clearTimeout(timer); resolve(); }
        if (event.kind === "error") { clearTimeout(timer); reject(new Error(event.text)); }
      });
    });
    void runEnded.catch(() => {});
    try {
      await adapter.start(workspace);
      await adapter.send("先运行 sleep 2，再给出最终回复。这是当前任务的一次工具测试。");
      await runEnded;
      await steeringCall;
      expect(providerError).toBeUndefined();
      expect(steered).toBe(true);
      expect(new Set(events.filter(e => e.phase === "running").map(e => e.runId)).size).toBe(1);
      if (!cancel) {
        expect(receivedInOriginalRun).toBe(true);
        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(new Set(events.filter(e => e.kind === "delivery" && e.deliveryState === "incorporated").map(e => e.messageId)).size).toBe(2);
        expect(events.filter(e => e.kind === "message").map(e => e.text).join("")).toContain(marker);
      } else {
        const count = requests.length;
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(requests).toHaveLength(count);
        expect(events.some(e => e.phase === "cancelling")).toBe(true);
        expect(events.filter(e => e.phase === "ready" && e.runId !== "session")).toHaveLength(1);
      }
      await expect(adapter.steer("不能启动新任务", "late-message")).rejects.toThrow(/结束|就绪|开始/);
    } finally {
      await adapter.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  }, 35000);
});
