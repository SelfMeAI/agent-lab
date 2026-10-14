import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executableName } from "../../../runtimes/platform.mjs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../../contracts/src/index";
import { ClaudeAdapter } from "./claude";
import { anthropic } from "./test-support/mock-model";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runtimeRoot = process.env.AGENT_LAB_STEERING_RUNTIME_ROOT ?? join(root, "runtimes");

describe("restored Claude grants still respect native safety", () => {
  it.runIf(process.env.AGENT_LAB_STEERING_INTEGRATION === "1")("preserves deny/ask rules, directory boundaries and user questions after reconnect", async () => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/claude-grant-safety-")), workspace = join(scratch, "workspace");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await writeFile(join(workspace, ".claude/settings.local.json"), JSON.stringify({ permissions: { deny: ["Edit(./blocked.txt)"], ask: ["Edit(./ask.txt)"] } }));
    const outside = join(scratch, "outside.txt"), events: RunEvent[] = [], errors: string[] = [];
    let count = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* The response sequence is deterministic. */ }
      if (!req.url?.includes("/messages") || req.url.includes("count_tokens")) { res.writeHead(200); res.end('{"input_tokens":20}'); return; }
      ++count;
      const paths: Record<number, string> = { 1: join(workspace, "safe.txt"), 3: join(workspace, "safe-again.txt"), 4: join(workspace, "ask.txt"), 5: join(workspace, "blocked.txt"), 6: outside };
      if (paths[count]) anthropic(res, { name: "Write", args: { file_path: paths[count], content: "native permission check\n" } });
      else if (count === 7) anthropic(res, { name: "AskUserQuestion", args: { questions: [{ header: "选择", question: "继续哪种方式？", options: [{ label: "继续", description: "继续测试" }, { label: "停止", description: "停止测试" }], multiSelect: false }] } });
      else anthropic(res, undefined, "验证完成");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const records = new Map<string, unknown>();
    const options = { executable: join(runtimeRoot, "claude/bin", executableName("claude")), homeDirectory: join(scratch, "home"), permissions: { get: (key: string) => records.get(key), set: (key: string, value: unknown) => { records.set(key, structuredClone(value)); } }, provider: async () => ({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: "claude-sonnet-4-6", apiKey: "sk-local-safety-check" }) };
    let adapter = new ClaudeAdapter(options);
    const observe = () => adapter.onEvent(event => {
      events.push(event); if (event.kind === "error") errors.push(event.text ?? "native error");
      if (event.kind === "approval" && event.approval) {
        const approval = event.approval;
        const response = approval.questions ? adapter.respondApproval(approval.requestId, "submit", { "0": ["继续"] })
          : adapter.respondApproval(approval.requestId, event.text?.includes(outside) ? "deny" : event.text?.includes("ask.txt") ? "allow_once" : "allow_session");
        void response.catch(error => errors.push(String(error)));
      }
    }); observe();
    try {
      await adapter.start(workspace); await adapter.send("先授权正常文件编辑");
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(events.some(event => event.phase === "ready" && event.sequence > 2)).toBe(true); }, { timeout: 15000 });
      const nativeRef = adapter.getResumeRef()!; await adapter.stop();
      adapter = new ClaudeAdapter(options); observe(); await adapter.start(workspace, nativeRef);
      const start = events.length; await adapter.send("检查已授权、显式询问、拒绝、目录外及用户提问");
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(events.slice(start).some(event => event.phase === "ready")).toBe(true); }, { timeout: 15000 });
      expect(count).toBe(8);
      expect(events.filter(event => event.kind === "approval").map(event => event.approval!.questions ? "question" : event.text?.includes(outside) ? "outside" : event.text?.includes("ask.txt") ? "ask" : "safe")).toEqual(["safe", "ask", "outside", "question"]);
      expect(await readFile(join(workspace, "safe-again.txt"), "utf8")).toContain("native permission check");
      await expect(readFile(join(workspace, "blocked.txt"))).rejects.toThrow();
      await expect(readFile(outside)).rejects.toThrow();
    } finally {
      await adapter.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(scratch, { recursive: true, force: true });
    }
  }, 45000);
});
