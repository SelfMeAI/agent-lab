import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../../contracts/src/index";
import { QwenAdapter } from "./qwen";
import { chat, prepareQwenTestHome, type Obj } from "./test-support/mock-model";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runtimeRoot = process.env.SELFME_STEERING_RUNTIME_ROOT ?? join(root, "runtimes");
const nodeExecutable = process.env.SELFME_STEERING_NODE_EXECUTABLE ?? process.execPath;

describe("Qwen Code native tools, permissions, diff and resume", () => {
  it.runIf(process.env.SELFME_STEERING_INTEGRATION === "1")("writes and edits only after approval, preserves native context on restart, and respects rejection", async () => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/qwen-native-"));
    const workspace = join(scratch, "workspace"); await mkdir(workspace);
    const homeDirectory = prepareQwenTestHome(join(scratch, "home"));
    const file = join(workspace, "proof.txt"), forbidden = join(workspace, "denied.txt");
    const requests: Obj[] = [], events: RunEvent[] = [], errors: string[] = [];
    let resumedWithContext = false;
    const server = createServer(async (req, res) => {
      try {
        let raw = ""; for await (const chunk of req) raw += String(chunk);
        const body = JSON.parse(raw) as Obj;
        const n = requests.push(body);
        const tools = body.tools.map((t: Obj) => t.function ?? t);
        if ([1, 2, 5].includes(n)) {
          const name = n === 2 ? "edit" : "write_file";
          const tool = tools.find((t: Obj) => t.name === name);
          if (!tool) throw new Error(`Missing ${name}`);
          const props = tool.parameters.properties;
          const pathField = props.file_path ? "file_path" : "absolute_path";
          chat(res, { name, args: { [pathField]: n === 5 ? forbidden : file,
            ...(n === 2 ? { old_string: "before", new_string: "after" } : { content: "before\n" }) } });
        } else if (n === 4) {
          const context = JSON.stringify(body.messages);
          resumedWithContext = context.includes("QWEN_HISTORY_MARKER_734") && context.includes("after");
          chat(res, undefined, "resumed-with-context");
        } else if (n === 3 || n === 6) chat(res, undefined, n === 3 ? "QWEN_HISTORY_MARKER_734 文件已完成" : "已尊重拒绝");
        else throw new Error(`Unexpected model request ${n}: ${JSON.stringify(body.messages?.at(-1)).slice(0, 300)}`);
      } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const provider = async () => ({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "deepseek-v4-flash", apiKey: "sk-local-qwen-check" });
    const make = () => {
      const adapter = new QwenAdapter({ homeDirectory, provider, nodeExecutable, entryPoint: join(runtimeRoot, "qwen-code/node_modules/@qwen-code/qwen-code/cli-entry.js") });
      adapter.onEvent(event => { events.push(event); if (event.kind === "error") errors.push(event.text ?? "Runtime error"); });
      return adapter;
    };
    let adapter = make();
    async function waitForApproval(after: number): Promise<RunEvent> {
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(events.slice(after).some(e => e.approval)).toBe(true); }, { timeout: 10000 });
      return events.slice(after).find(e => e.approval)!;
    }
    async function answer(approval: RunEvent, allow: boolean): Promise<void> {
      const option = approval.approval!.options.find(o => o.kind === (allow ? "allow_once" : "reject_once"))!;
      expect(option).toBeTruthy(); await adapter.respondApproval(approval.approval!.requestId, option.optionId);
    }
    async function waitForEnd(after: number): Promise<void> {
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(events.slice(after).some(e => e.phase === "ready"), JSON.stringify(events.slice(after).map(e => ({ kind: e.kind, phase: e.phase, title: e.title, text: e.text?.slice(0, 200) })))).toBe(true); }, { timeout: 10000 });
    }
    try {
      await adapter.start(workspace);
      const first = events.length;
      await adapter.send("QWEN_HISTORY_MARKER_734 写入文件，再将 before 修改为 after。");
      const write = await waitForApproval(first);
      await expect(readFile(file, "utf8")).rejects.toThrow();
      const writeIndex = events.length;
      await answer(write, true);
      const edit = await waitForApproval(writeIndex);
      expect(await readFile(file, "utf8")).toBe("before\n");
      await answer(edit, true); await waitForEnd(first);
      expect(await readFile(file, "utf8")).toBe("after\n");
      expect(events.filter(e => e.kind === "message").every(e => Boolean(e.text))).toBe(true);
      const changes = events.filter(e => e.kind === "tool").flatMap(e => (e.raw as Obj)?.content ?? []).filter(c => c.type === "diff");
      expect(changes.some(c => c.newText === "before\n")).toBe(true);
      expect(changes.some(c => c.oldText === "before\n" && c.newText === "after\n")).toBe(true);
      const ref = adapter.getResumeRef()!; await adapter.stop();
      adapter = make(); await adapter.start(workspace, ref);
      expect(adapter.getResumeRef()).toBe(ref);
      const second = events.length; await adapter.send("继续之前的上下文"); await waitForEnd(second);
      expect(resumedWithContext).toBe(true);
      const third = events.length; await adapter.send("测试拒绝文件写入");
      const reject = await waitForApproval(third); await answer(reject, false); await waitForEnd(third);
      await expect(readFile(forbidden, "utf8")).rejects.toThrow();
      expect(requests.length).toBeLessThanOrEqual(6);
    } finally {
      await adapter.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  }, 35000);
});
