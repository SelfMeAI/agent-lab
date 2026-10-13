import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { executableName } from "../../../../runtimes/platform.mjs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeId, AgentSessionEvent } from "../../../../packages/contracts/src/index";
import { CodexAdapter } from "../../../../packages/runtime/src/codex";
import { DshAdapter } from "../../../../packages/runtime/src/dsh";
import { PiAdapter } from "../../../../packages/runtime/src/pi";
import { KimiAdapter } from "../../../../packages/runtime/src/kimi";
import { QwenAdapter } from "../../../../packages/runtime/src/qwen";
import { ClaudeAdapter } from "../../../../packages/runtime/src/claude";
import { anthropic, chat, responses, shellTool, prepareQwenTestHome, type Obj } from "../../../../packages/runtime/src/test-support/mock-model";
import { AgentSessionController } from "./agent-session-controller";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const runtimeRoot = process.env.AGENT_LAB_STEERING_RUNTIME_ROOT ?? join(root, "runtimes");
const nodeExecutable = process.env.AGENT_LAB_STEERING_NODE_EXECUTABLE ?? process.execPath;

describe("real native session approval lifetime", () => {
  const cases = (["claude-code", "pi", "codex", "kimi-code", "qwen-code", "dsh"] as const).map(id => ({ id, files: false }));
  cases.push({ id: "qwen-code", files: true });
  it.runIf(process.env.AGENT_LAB_STEERING_INTEGRATION === "1").each(cases)("$id preserves its native approval scope on reconnect (file editing=$files)", async ({ id, files }) => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/permission-native-")), workspace = join(scratch, "workspace"); await mkdir(workspace);
    const errors: string[] = [], approvals: AgentSessionEvent[] = [], events: AgentSessionEvent[] = [];
    let round = 0, count = 0;
    const server = createServer(async (req, res) => {
      try {
        let raw = ""; for await (const chunk of req) raw += String(chunk);
        if (id === "claude-code" && (!req.url?.includes("/messages") || req.url.includes("count_tokens"))) { res.writeHead(200); res.end('{"input_tokens":20}'); return; }
        const body = JSON.parse(raw) as Obj; ++count;
        const respond = id === "claude-code" ? anthropic : req.url?.includes("responses") ? responses : chat;
        if (files && round > 1 && count === 1) {
          const tool = body.tools.map((entry: Obj) => entry.function ?? entry).find((entry: Obj) => entry.name === "read_file");
          const pathKey = tool.parameters.properties.file_path ? "file_path" : "absolute_path";
          respond(res, { name: "read_file", args: { [pathKey]: join(workspace, "approval-check.txt") } });
        } else if (count === (files && round > 1 ? 2 : 1)) {
          if (files) {
            const name = round === 1 ? "write_file" : "edit";
            const tool = body.tools.map((entry: Obj) => entry.function ?? entry).find((entry: Obj) => entry.name === name);
            const pathKey = tool.parameters.properties.file_path ? "file_path" : "absolute_path";
            respond(res, { name, args: { [pathKey]: join(workspace, "approval-check.txt"), ...(round === 1 ? { content: "round-1\n" } : { old_string: `round-${round - 1}`, new_string: `round-${round}` }) } });
          } else if (id === "claude-code") respond(res, round === 1
            ? { name: "Write", args: { file_path: join(workspace, "approval-check.txt"), content: "round-1\n" } }
            : { name: "Edit", args: { file_path: join(workspace, "approval-check.txt"), old_string: `round-${round - 1}`, new_string: `round-${round}` } });
          else {
            const tool = shellTool(body), command = "printf 'session approval check\\n' >> approval-check.txt";
            if (tool.args.cmd) { tool.args.cmd = command; tool.args.sandbox_permissions = "require_escalated"; tool.args.justification = "Verify remembered session approval"; }
            else tool.args.command = Array.isArray(tool.args.command) ? ["/bin/sh", "-c", command] : command;
            respond(res, tool);
          }
        } else if (count === (files && round > 1 ? 3 : 2)) respond(res, undefined, "已执行授权检查");
        else throw new Error("Unexpected extra model request in permission test");
      } catch (error) { errors.push(String(error)); if (!res.destroyed) { res.writeHead(500); res.end('{"error":{"type":"api_error","message":"test failed"}}'); } }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const provider = async () => ({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "sk-local-permission-check", model: id === "claude-code" ? "claude-sonnet-4-6" : "deepseek-v4-flash" });
    let repository = new AgentSessionRepository(join(scratch, "data")); await repository.init();
    const config = new AppConfigStore(join(scratch, "data")); await config.init();
    const controller = () => new AgentSessionController(repository, config, (_runtime: AgentRuntimeId, sid: string) => {
      const homeDirectory = join(scratch, "homes", sid), permissions = repository.permissionStore(sid);
      if (id === "claude-code") return new ClaudeAdapter({ homeDirectory, provider, permissions, executable: join(runtimeRoot, "claude/bin/claude") });
      if (id === "pi") return new PiAdapter({ homeDirectory, provider, permissions });
      if (id === "codex") return new CodexAdapter({ homeDirectory, provider, permissions, executable: join(runtimeRoot, "codex/bin", executableName("codex")) });
      if (id === "dsh") return new DshAdapter({ homeDirectory, provider, nodeExecutable, entryPoint: join(runtimeRoot, "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"), steeringLoader: join(runtimeRoot, "dsh/steering-loader.mjs") });
      if (id === "qwen-code") return new QwenAdapter({ homeDirectory: prepareQwenTestHome(homeDirectory), provider, permissions, nodeExecutable, entryPoint: join(runtimeRoot, "qwen-code/node_modules/@qwen-code/qwen-code/cli-entry.js") });
      return new KimiAdapter({ homeDirectory, provider, nodeExecutable, entryPoint: join(runtimeRoot, "kimi-code/node_modules/@moonshot-ai/kimi-code/dist/main.mjs"), steeringLoader: join(runtimeRoot, "kimi-code/steering-loader.mjs") });
    }, event => {
      events.push(event);
      if (event.kind === "error") errors.push(event.text ?? "native error");
      if (event.kind === "approval" && event.approval) {
        approvals.push(event);
        const option = event.approval.options.find(item => item.optionId === "proceed_always_project")
          ?? event.approval.options.find(item => ["allow_session", "allow_always"].includes(item.kind))
          ?? event.approval.options.find(item => item.kind.includes("allow"));
        if (!option) errors.push("No approval option");
        else void c.respondApproval(event.sessionId, event.approval.requestId, option.optionId).catch(error => errors.push(String(error)));
      }
    });
    let c = controller();
    try {
      const session = await c.create(id, workspace), approvalCounts: number[] = [];
      for (round = 1; round <= 3; round++) {
        if (round === 3) {
          await c.stopAll(); repository.close();
          repository = new AgentSessionRepository(join(scratch, "data")); await repository.init(); c = controller();
        }
        count = 0; const before = approvals.length;
        await c.send(session.id, `PERMISSION_CHECK_CONTEXT_871 第 ${round} 次执行测试工具。`);
        await vi.waitFor(() => { expect(errors).toEqual([]); expect(repository.get(session.id).phase).toBe("ready"); }, { timeout: 20000 });
        expect(count).toBe(files && round > 1 ? 3 : 2);
        approvalCounts.push(approvals.length - before);
      }
      // This DSH command is natively low-risk and does not need approval;
      // its ACP only offers once/reject for operations that actually ask.
      expect(approvalCounts).toEqual(id === "dsh" ? [0, 0, 0] : [1, 0, 0]);
      expect(await readFile(join(workspace, "approval-check.txt"), "utf8")).toBe(id === "claude-code" || files ? "round-3\n" : "session approval check\nsession approval check\nsession approval check\n");
      const sibling = await c.create(id, workspace); count = 0;
      const before = approvals.length; await c.send(sibling.id, "PERMISSION_CHECK_CONTEXT_871 新会话独立授权检查。");
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(repository.get(sibling.id).phase).toBe("ready"); }, { timeout: 20000 });
      // Qwen explicitly offered a project-wide rule, so another session in
      // that project inherits it natively. Other grants are session-only.
      expect(approvals.length - before).toBe(id === "dsh" || (id === "qwen-code" && !files) ? 0 : 1);
      const receipts = events.filter(event => event.kind === "approval_result" && event.approvalDecision);
      expect(receipts.length).toBeGreaterThanOrEqual(approvals.length);
      expect(receipts.every(event => event.approval!.options.some(option => option.optionId === event.approvalDecision!.optionId))).toBe(true);
    } finally {
      await c.stopAll(); repository.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  }, 65000);
});
