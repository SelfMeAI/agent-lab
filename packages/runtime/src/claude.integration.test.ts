import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../../contracts/src/index";
import { ClaudeAdapter } from "./claude";
import { anthropic, type Obj } from "./test-support/mock-model";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runtimeRoot = process.env.AGENT_LAB_STEERING_RUNTIME_ROOT ?? join(root, "runtimes");

describe("official Claude native runtime", () => {
  it.runIf(process.env.AGENT_LAB_STEERING_INTEGRATION === "1")("streams without duplication, edits with native approval and diffs, accepts answers, stops and resumes", async () => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/claude-native-"));
    const workspace = join(scratch, "workspace"); await mkdir(workspace);
    const events: RunEvent[] = [], requests: Obj[] = [], errors: string[] = [];
    let stage = "files", questionPending = false;
    const server = createServer(async (req, res) => {
      try {
        let raw = ""; for await (const chunk of req) raw += String(chunk);
        if (!req.url?.includes("/messages") || req.url.includes("count_tokens")) { res.writeHead(200); res.end('{"input_tokens":20}'); return; }
        const body = JSON.parse(raw) as Obj; requests.push(body);
        if (stage === "files") {
          const count = requests.length;
          if (count === 1) anthropic(res, { name: "Write", args: { file_path: join(workspace, "example.txt"), content: "before\n" } });
          else if (count === 2) anthropic(res, { name: "Edit", args: { file_path: join(workspace, "example.txt"), old_string: "before", new_string: "after" } });
          else anthropic(res, undefined, "已完成文件修改");
        } else if (questionPending) {
          questionPending = false;
          anthropic(res, { name: "AskUserQuestion", args: { questions: [
            { header: "风格", question: "选择哪种风格？", options: [{ label: "简约", description: "简单" }, { label: "深空", description: "星空" }], multiSelect: false },
            { header: "平台", question: "支持哪些平台？", options: [{ label: "电脑", description: "桌面" }, { label: "手机", description: "移动" }], multiSelect: true },
          ] } });
        } else anthropic(res, undefined, "已根据你的回答继续");
      } catch (error) { errors.push(String(error)); res.writeHead(500); res.end('{"error":{"type":"api_error","message":"test failure"}}'); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const options = { executable: join(runtimeRoot, "claude/bin/claude"), homeDirectory: join(scratch, "home"), provider: async () => ({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: "claude-sonnet-4-6", apiKey: "sk-local-claude-check" }) };
    let adapter = new ClaudeAdapter(options);
    const observe = () => adapter.onEvent(event => { events.push(event); if (event.kind === "error") errors.push(event.text ?? "Claude error"); }); observe();
    const wait = async (predicate: () => boolean) => vi.waitFor(() => { expect(errors).toEqual([]); expect(predicate(), JSON.stringify(events.slice(-8))).toBe(true); }, { timeout: 15000 });
    try {
      expect((await adapter.probe()).availability).toBe("ready");
      await adapter.start(workspace);
      const start = events.length; await adapter.send("CLAUDE_CONTEXT_719 创建文件，然后修改，最后说明结果。");
      await wait(() => events.slice(start).some(e => e.kind === "approval"));
      const permission = events.slice(start).find(e => e.kind === "approval")!.approval!;
      expect(permission.title).toBe("写入文件");
      const remember = permission.options.find(o => o.optionId === "allow_session");
      await adapter.respondApproval(permission.requestId, remember?.optionId ?? "allow_once");
      // If Claude narrows its permission suggestion to the exact first tool,
      // approve Edit separately instead of assuming our own broad bypass.
      await wait(() => events.slice(start).some(e => e.phase === "ready") || events.slice(start).some(e => e.kind === "approval" && e.approval?.requestId !== permission.requestId));
      const second = events.slice(start).find(e => e.kind === "approval" && e.approval?.requestId !== permission.requestId)?.approval;
      if (second) await adapter.respondApproval(second.requestId, "allow_once");
      await wait(() => events.slice(start).some(e => e.phase === "ready"));
      expect(await readFile(join(workspace, "example.txt"), "utf8")).toBe("after\n");
      const edits = events.slice(start).filter(e => e.kind === "tool" && e.toolStatus === "completed");
      expect(edits).toHaveLength(2);
      expect((edits[1].raw as Obj).content).toEqual([{ type: "diff", path: join(workspace, "example.txt"), oldText: "before\n", newText: "after\n" }]);
      expect(events.slice(start).filter(e => e.kind === "message").map(e => e.text).join("")).toBe("已完成文件修改");
      await expect(adapter.respondApproval(permission.requestId, "allow_once")).rejects.toThrow(/失效/);

      stage = "questions"; questionPending = true;
      const qs = events.length; await adapter.send("先提问，再继续。");
      await wait(() => events.slice(qs).some(e => e.approval?.questions));
      const question = events.slice(qs).find(e => e.approval?.questions)!.approval!;
      expect(question.questions!.every(q => q.allowCustom)).toBe(true);
      await expect(adapter.respondApproval(question.requestId, "submit", {})).rejects.toThrow(/回答/);
      await adapter.respondApproval(question.requestId, "submit", { "0": ["CUSTOM_STYLE_873"], "1": ["电脑", "CUSTOM_PLATFORM_629"] });
      await wait(() => events.slice(qs).some(e => e.phase === "ready"));
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain("CUSTOM_STYLE_873");
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain("CUSTOM_PLATFORM_629");

      questionPending = true; const cancel = events.length; await adapter.send("再提问，测试停止。");
      await wait(() => events.slice(cancel).some(e => e.approval?.questions));
      const stale = events.slice(cancel).find(e => e.approval?.questions)!.approval!;
      await adapter.cancel();
      await expect(adapter.respondApproval(stale.requestId, "submit", { "0": ["深空"], "1": ["电脑"] })).rejects.toThrow(/失效/);
      const nativeRef = adapter.getResumeRef()!;
      await adapter.stop(); adapter = new ClaudeAdapter(options); observe();
      await adapter.start(workspace, nativeRef);
      const resume = events.length; await adapter.send("根据之前的回答继续，不要重新提问。");
      await wait(() => events.slice(resume).some(e => e.phase === "ready"));
      const context = JSON.stringify(requests.at(-1)?.messages);
      expect(context).toContain("CLAUDE_CONTEXT_719"); expect(context).toContain("CUSTOM_STYLE_873");
    } finally {
      await adapter.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  }, 60000);

  it.runIf(process.env.AGENT_LAB_STEERING_INTEGRATION === "1")("incorporates Steer in the active native loop, not by restarting a turn", async () => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/claude-steer-")), workspace = join(scratch, "workspace"); await mkdir(workspace);
    const events: RunEvent[] = [], errors: string[] = [], requests: Obj[] = [];
    const server = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += String(chunk);
      if (!req.url?.includes("/messages") || req.url.includes("count_tokens")) { res.writeHead(200); res.end('{"input_tokens":20}'); return; }
      const body = JSON.parse(raw) as Obj; requests.push(body);
      if (requests.length === 1) anthropic(res, { name: "Bash", args: { command: "sleep 2", description: "给补充指令留出工具边界", timeout: 10000 } });
      else anthropic(res, undefined, JSON.stringify(body.messages).includes("CLAUDE_STEER_842") ? "补充已进入当前任务" : "没有收到补充");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const adapter = new ClaudeAdapter({ executable: join(runtimeRoot, "claude/bin/claude"), homeDirectory: join(scratch, "home"), provider: async () => ({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: "claude-sonnet-4-6", apiKey: "sk-local-claude-steer" }) });
    adapter.onEvent(e => { events.push(e); if (e.kind === "error") errors.push(e.text ?? "Claude error"); if (e.kind === "approval" && e.approval) void adapter.respondApproval(e.approval.requestId, "allow_once"); });
    try {
      await adapter.start(workspace); const start = events.length; await adapter.send("先执行命令，再总结。");
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(events.slice(start).some(e => e.kind === "tool" && e.toolStatus === "in_progress")).toBe(true); }, { timeout: 15000 });
      await adapter.steer("CLAUDE_STEER_842 在当前任务中采用这个补充。", "app-steer-842");
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(events.slice(start).some(e => e.phase === "ready")).toBe(true); }, { timeout: 15000 });
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].messages)).toContain("CLAUDE_STEER_842");
      expect(events.some(e => e.messageId === "app-steer-842" && e.deliveryState === "incorporated")).toBe(true);
      const finished = events.find(e => e.kind === "tool" && e.toolStatus === "completed");
      expect(finished).toBeDefined(); expect((finished!.raw as Obj).durationMs).toBeGreaterThanOrEqual(1600);
      const active = events.slice(start); expect(new Set(active.filter(e => e.kind === "tool" || e.kind === "message").map(e => e.runId)).size).toBe(1);
      expect(active.filter(e => e.phase === "ready")).toHaveLength(1);
    } finally {
      await adapter.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30000);
});
