import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../../packages/contracts/src/index";
import { CodexAdapter } from "../../../../packages/runtime/src/codex";
import { DshAdapter } from "../../../../packages/runtime/src/dsh";
import { PiAdapter } from "../../../../packages/runtime/src/pi";
import { KimiAdapter } from "../../../../packages/runtime/src/kimi";
import { QwenAdapter } from "../../../../packages/runtime/src/qwen";
import { chat, responses, shellTool, prepareQwenTestHome, type Obj } from "../../../../packages/runtime/src/test-support/mock-model";
import { AgentSessionController } from "./agent-session-controller";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const runtimeRoot = process.env.SELFME_STEERING_RUNTIME_ROOT ?? join(root, "runtimes");
const nodeExecutable = process.env.SELFME_STEERING_NODE_EXECUTABLE ?? process.execPath;

describe("real bundled harnesses: independent concurrent sessions", () => {
  it.runIf(process.env.SELFME_STEERING_INTEGRATION === "1").each(["codex", "dsh", "pi", "kimi-code", "qwen-code"] as const)("%s runs two sessions, cancels only one, and drains the other in background", async id => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/parallel-native-"));
    const workspaces = { A: join(scratch, "workspace-a"), B: join(scratch, "workspace-b") };
    await Promise.all(Object.values(workspaces).map(path => mkdir(path)));
    const markers = { A: "SELFME_PARALLEL_A_437", B: "SELFME_PARALLEL_B_961" };
    const requests: Record<"A" | "B", Obj[]> = { A: [], B: [] };
    const releases: Partial<Record<"A" | "B", () => void>> = {};
    const gates = Object.fromEntries((["A", "B"] as const).map(key => [key, new Promise<void>(resolve => { releases[key] = resolve; })])) as Record<"A" | "B", Promise<void>>;
    const errors: string[] = [];
    const server = createServer(async (req, res) => {
      try {
        let raw = ""; for await (const chunk of req) raw += String(chunk);
        const body = JSON.parse(raw) as Obj;
        const input = JSON.stringify(body.messages ?? body.input);
        const key = input.includes(markers.A) ? "A" : input.includes(markers.B) ? "B" : null;
        if (!key) throw new Error("Missing session marker");
        if (input.includes(markers[key === "A" ? "B" : "A"])) throw new Error("Cross-session model context");
        const count = requests[key].push(body);
        if (count > 3) throw new Error(`Unexpected model request loop: ${JSON.stringify((body.messages ?? body.input)?.at(-1)).slice(0, 900)}`);
        const respond = req.url?.includes("responses") ? responses : chat;
        if (count === 1) {
          const tool = shellTool(body);
          const command = "pwd > session-workspace.txt; sleep 1";
          if (tool.args.cmd) tool.args.cmd = command;
          else tool.args.command = Array.isArray(tool.args.command) ? ["/bin/sh", "-c", command] : command;
          respond(res, tool);
        } else {
          if (count === 2) await gates[key];
          if (!res.destroyed) respond(res, undefined, `${key} completed turn ${count}`);
        }
      } catch (error) {
        errors.push(String(error));
        if (!res.destroyed) { res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const provider = async () => ({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "sk-local-parallel-check", model: "deepseek-v4-flash" });
    const repository = new AgentSessionRepository(join(scratch, "data")); await repository.init();
    const config = new AppConfigStore(join(scratch, "data")); await config.init();
    const events: AgentSessionEvent[] = [];
    const c = new AgentSessionController(repository, config, (_runtime, sid) => {
      const homeDirectory = join(scratch, "home", sid);
      if (id === "codex") return new CodexAdapter({ homeDirectory, provider, executable: join(runtimeRoot, "codex/bin/codex") });
      if (id === "pi") return new PiAdapter({ homeDirectory, provider });
      if (id === "dsh") return new DshAdapter({ homeDirectory, provider, nodeExecutable, entryPoint: join(runtimeRoot, "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"), steeringLoader: join(runtimeRoot, "dsh/steering-loader.mjs") });
      if (id === "qwen-code") return new QwenAdapter({ homeDirectory: prepareQwenTestHome(homeDirectory), provider, nodeExecutable, entryPoint: join(runtimeRoot, "qwen-code/node_modules/@qwen-code/qwen-code/cli-entry.js") });
      return new KimiAdapter({ homeDirectory, provider, nodeExecutable, entryPoint: join(runtimeRoot, "kimi-code/node_modules/@moonshot-ai/kimi-code/dist/main.mjs"), steeringLoader: join(runtimeRoot, "kimi-code/steering-loader.mjs") });
    }, event => {
      events.push(event);
      if (event.kind === "error") errors.push(event.text ?? "native error");
      if (event.kind === "approval" && event.approval) {
        const option = event.approval.options.find(item => item.kind.includes("allow"));
        if (option) void c.respondApproval(event.sessionId, event.approval.requestId, option.optionId).catch(error => errors.push(String(error)));
      }
    });
    try {
      const a = await c.create(id, workspaces.A);
      await c.send(a.id, `${markers.A} 执行工具，然后回复。`);
      const b = await c.create(id, workspaces.B);
      await c.send(b.id, `${markers.B} 执行工具，然后回复。`);
      await vi.waitFor(() => {
        expect(errors).toEqual([]);
        expect(requests.A).toHaveLength(2); expect(requests.B).toHaveLength(2);
      }, { timeout: 20000, interval: 50 });
      expect(repository.get(a.id).phase).toBe("running");
      expect(repository.get(b.id).phase).toBe("running");
      expect((await readFile(join(workspaces.A, "session-workspace.txt"), "utf8")).trim()).toBe(workspaces.A);
      expect((await readFile(join(workspaces.B, "session-workspace.txt"), "utf8")).trim()).toBe(workspaces.B);
      await c.enqueue(a.id, "A 的队列必须保留");
      await c.enqueue(b.id, "B 的队列继续执行");
      await c.cancel(a.id);
      expect(repository.queue(a.id)).toMatchObject({ paused: true, messages: [{ text: "A 的队列必须保留" }] });
      expect(repository.get(b.id).phase).toBe("running");
      await c.select(a.id);
      releases.A!(); releases.B!();
      await vi.waitFor(() => {
        expect(errors).toEqual([]);
        expect(repository.get(b.id).phase).toBe("ready");
        expect(repository.queue(b.id).messages).toHaveLength(0);
        expect(requests.B).toHaveLength(3);
      }, { timeout: 10000, interval: 50 });
      expect(c.catalog(id).selectedSessionId).toBe(a.id);
      expect(repository.queue(a.id).messages).toHaveLength(1);
      expect(requests.A).toHaveLength(2);
      expect(events.filter(e => e.sessionId === b.id && e.kind === "user").map(e => e.text)).toEqual([`${markers.B} 执行工具，然后回复。`, "B 的队列继续执行"]);
      expect(events.filter(e => e.sessionId === a.id && e.kind === "message").some(e => e.text?.includes("B completed"))).toBe(false);
      expect(events.some(e => e.sessionId === b.id && e.kind === "message" && e.text?.includes("B completed turn 3"))).toBe(true);
    } finally {
      releases.A!(); releases.B!();
      await c.stopAll(); repository.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  }, 35000);
});
