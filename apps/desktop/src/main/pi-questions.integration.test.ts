import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, ApprovalRequest } from "../../../../packages/contracts/src/index";
import { PiAdapter } from "../../../../packages/runtime/src/pi";
import { chat, type Obj } from "../../../../packages/runtime/src/test-support/mock-model";
import { AgentSessionController } from "./agent-session-controller";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
describe("Pi SDK custom question tool: app persistence and concurrent sessions", () => {
  it.runIf(process.env.AGENT_LAB_STEERING_INTEGRATION === "1")("isolates pending answers, stops one session, persists the other and resumes its native context", async () => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/pi-questions-"));
    const workspace = join(scratch, "workspace"); await mkdir(workspace);
    const requests: Record<string, Obj[]> = { A: [], B: [] }, errors: string[] = [];
    const server = createServer(async (req, res) => {
      try {
        let raw = ""; for await (const chunk of req) raw += String(chunk);
        const body = JSON.parse(raw) as Obj, context = JSON.stringify(body.messages);
        const key = context.includes("PI_QUESTION_SESSION_A_729") ? "A" : context.includes("PI_QUESTION_SESSION_B_943") ? "B" : null;
        if (!key || context.includes(key === "A" ? "PI_QUESTION_SESSION_B_943" : "PI_QUESTION_SESSION_A_729")) throw new Error("Pi question session context mixed");
        const count = requests[key].push(body);
        if (count === 1) {
          if (!body.tools.some((tool: Obj) => tool.function?.name === "ask_user_question")) throw new Error("Pi custom question tool not registered");
          chat(res, { name: "ask_user_question", args: { questions: [
            { id: "style", header: "风格", question: "想要哪种风格？", options: [{ label: "简约" }, { label: "深空" }] },
            { id: "platform", header: "平台", question: "支持哪些平台？", multi_select: true, options: [{ label: "电脑" }, { label: "手机" }] },
          ] } });
        } else {
          const outputs = body.messages.filter((message: Obj) => message.role === "tool").map((message: Obj) => JSON.parse(message.content));
          if (!outputs.some((output: Obj) => output.answers?.style?.includes("星空_ANSWER_B_387") && output.answers.platform.includes("电脑") && output.answers.platform.includes("主机_ANSWER_B_648"))) {
            throw new Error("Pi custom answers missing from tool context");
          }
          chat(res, undefined, count === 2 ? "已收到你的选择" : "已根据保留的选择继续");
        }
      } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const provider = async () => ({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "deepseek-v4-flash", apiKey: "sk-local-pi-questions-check" });
    const data = join(scratch, "data"), events: AgentSessionEvent[] = [];
    let repository = new AgentSessionRepository(data); await repository.init();
    const config = new AppConfigStore(data); await config.init();
    const createController = () => new AgentSessionController(repository, config, (_id, sessionId) => new PiAdapter({
      homeDirectory: join(scratch, "homes", sessionId), provider,
    }), event => { events.push(event); if (event.kind === "error") errors.push(event.text ?? "Pi error"); });
    let c = createController();
    const question = (sessionId: string): ApprovalRequest => events.find(e => e.sessionId === sessionId && e.approval?.questions?.length)!.approval!;
    try {
      const a = await c.create("pi", workspace), b = await c.create("pi", workspace);
      await c.send(a.id, "PI_QUESTION_SESSION_A_729 请先向我提问，再继续。不要操作文件。");
      await c.send(b.id, "PI_QUESTION_SESSION_B_943 请先向我提问，再继续。不要操作文件。");
      await vi.waitFor(() => {
        expect(errors).toEqual([]);
        expect(events.some(e => e.sessionId === a.id && e.approval?.questions?.length)).toBe(true);
        expect(events.some(e => e.sessionId === b.id && e.approval?.questions?.length)).toBe(true);
      }, { timeout: 10000 });
      expect(repository.get(a.id).phase).toBe("approval"); expect(repository.get(b.id).phase).toBe("approval");
      await c.select(a.id);
      await expect(c.respondApproval(b.id, question(a.id).requestId, "cancel")).rejects.toThrow(/失效/);
      expect(repository.get(b.id).phase).toBe("approval");
      await c.cancel(a.id);
      expect(repository.get(a.id).phase).toBe("ready"); expect(requests.A).toHaveLength(1);
      expect(repository.get(b.id).phase).toBe("approval");
      expect(repository.events(a.id).some(e => e.kind === "approval_result" && e.approval?.requestId === question(a.id).requestId)).toBe(true);
      await expect(c.respondApproval(a.id, question(a.id).requestId, "submit", { style: ["深空"], platform: ["电脑"] })).rejects.toThrow(/失效/);
      await c.respondApproval(b.id, question(b.id).requestId, "submit", { style: ["星空_ANSWER_B_387"], platform: ["电脑", "主机_ANSWER_B_648"] });
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(repository.get(b.id).phase).toBe("ready"); }, { timeout: 10000 });
      expect(requests.B).toHaveLength(2); expect(c.catalog("pi").selectedSessionId).toBe(a.id);
      expect(repository.events(b.id).find(e => e.kind === "approval_result")?.text).toBe("风格：星空_ANSWER_B_387\n平台：电脑、主机_ANSWER_B_648");
      const tool = repository.events(b.id).find(e => e.kind === "tool" && e.toolStatus === "completed");
      expect(tool?.text).toContain("风格：星空_ANSWER_B_387"); expect(tool?.text).not.toContain('"answers"');
      await c.stopAll(); repository.close();
      repository = new AgentSessionRepository(data); await repository.init(); c = createController();
      expect(repository.events(b.id).find(e => e.kind === "approval_result")?.text).toContain("星空_ANSWER_B_387");
      await c.send(b.id, "根据上次选择继续，不要重新提问，也不要操作文件。");
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(repository.get(b.id).phase).toBe("ready"); expect(requests.B).toHaveLength(3); }, { timeout: 10000 });
      expect(requests.A).toHaveLength(1);
    } finally {
      await c.stopAll(); repository.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30000);
});
