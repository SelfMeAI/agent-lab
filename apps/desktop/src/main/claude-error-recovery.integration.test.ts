import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../../packages/contracts/src/index";
import { ClaudeAdapter } from "../../../../packages/runtime/src/claude";
import { anthropic, type Obj } from "../../../../packages/runtime/src/test-support/mock-model";
import { composerAction } from "../renderer/labs/agent-lab/follow-up";
import { AgentSessionController } from "./agent-session-controller";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const runtimeRoot = process.env.AGENT_LAB_STEERING_RUNTIME_ROOT ?? join(root, "runtimes");

describe("Claude failed-turn recovery", () => {
  it.runIf(process.env.AGENT_LAB_STEERING_INTEGRATION === "1")("reconnects on the next send in the same selected session with original context and error history intact", async () => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/claude-recovery-")), workspace = join(scratch, "workspace"); await mkdir(workspace);
    const requests: Obj[] = [], events: AgentSessionEvent[] = [];
    const server = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += String(chunk);
      if (!req.url?.includes("/messages") || req.url.includes("count_tokens")) { res.writeHead(200); res.end('{"input_tokens":20}'); return; }
      requests.push(JSON.parse(raw));
      if (requests.length === 3) {
        // A non-retryable provider error reaches the same terminal error state
        // as an exhausted 524, without spending minutes on native retry delays.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Synthetic provider failure for recovery verification" } }));
      } else if (requests.length === 1) anthropic(res, { name: "Write", args: { file_path: join(workspace, "recovery.txt"), content: "before\n" } });
      else if (requests.length === 4) anthropic(res, { name: "Edit", args: { file_path: join(workspace, "recovery.txt"), old_string: "before", new_string: "after" } });
      else anthropic(res, undefined, requests.length === 2 ? "原始任务已完成" : "恢复后继续执行");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const repository = new AgentSessionRepository(join(scratch, "data")); await repository.init();
    const config = new AppConfigStore(join(scratch, "data")); await config.init();
    const instances: ClaudeAdapter[] = [];
    const controller = new AgentSessionController(repository, config, (_runtime, sid) => {
      const adapter = new ClaudeAdapter({ executable: join(runtimeRoot, "claude/bin/claude"), homeDirectory: join(scratch, "homes", sid), permissions: repository.permissionStore(sid), provider: async () => ({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: "claude-sonnet-4-6", apiKey: "sk-local-recovery-test" }) });
      instances.push(adapter); return adapter;
    }, event => {
      events.push(event);
      if (event.kind === "approval" && event.approval) void controller.respondApproval(event.sessionId, event.approval.requestId, "allow_session");
    });
    try {
      const session = await controller.create("claude-code", workspace);
      await controller.send(session.id, "CLAUDE_ORIGINAL_CONTEXT_963 这是原始工作内容。");
      await vi.waitFor(() => expect(repository.get(session.id).phase).toBe("ready"), { timeout: 10000 });
      await controller.send(session.id, "这条请求会遇到模型服务错误。");
      await vi.waitFor(() => expect(repository.get(session.id).phase).toBe("error"), { timeout: 10000 });
      const errors = repository.events(session.id).filter(e => e.kind === "error"); expect(errors).toHaveLength(1);
      expect(composerAction(repository.get(session.id).phase, repository.queue(session.id), "queue")).toBe("send");
      await controller.send(session.id, "CLAUDE_RECOVERY_425 根据原始内容继续。");
      await vi.waitFor(() => expect(repository.get(session.id).phase).toBe("ready"), { timeout: 10000 });
      expect(instances).toHaveLength(2); expect(requests).toHaveLength(5);
      expect(controller.catalog("claude-code").selectedSessionId).toBe(session.id);
      const context = JSON.stringify(requests[4].messages);
      expect(context).toContain("CLAUDE_ORIGINAL_CONTEXT_963"); expect(context).toContain("CLAUDE_RECOVERY_425");
      expect(repository.events(session.id).filter(e => e.kind === "error")).toEqual(errors);
      expect(events.filter(e => e.kind === "user")).toHaveLength(3);
      expect(events.filter(e => e.kind === "message").map(e => e.text).join("")).toContain("恢复后继续执行");
      expect(events.filter(e => e.kind === "approval")).toHaveLength(1);
      expect(events.find(e => e.kind === "approval_result")?.approvalDecision?.optionId).toBe("allow_session");
      expect(await readFile(join(workspace, "recovery.txt"), "utf8")).toBe("after\n");
    } finally {
      await controller.stopAll(); repository.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  }, 35000);
});
