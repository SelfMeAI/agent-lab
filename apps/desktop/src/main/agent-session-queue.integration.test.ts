import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../../packages/contracts/src/index";
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
const queueMarker = "AGENT_LAB_FOLLOW_UP_QUEUE_826";
const steerMarker = "AGENT_LAB_STEER_CURRENT_TURN_973";

describe("real bundled harnesses: queued turn versus mid-turn Steer", () => {
  const cases = (["codex", "dsh", "pi", "kimi-code", "qwen-code", "claude-code"] as const).flatMap(id => [{ id, cancel: false }, { id, cancel: true }]);
  it.runIf(process.env.AGENT_LAB_STEERING_INTEGRATION === "1").each(cases)("$id queue and Steer (cancel=$cancel)", async ({ id, cancel }) => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/queue-native-"));
    const workspace = join(scratch, "workspace"); await mkdir(workspace);
    const requests: Array<{ body: Obj; originalEnded: boolean }> = [];
    let originalEnded = false, providerError: unknown, nativeError: string | undefined;
    const server = createServer(async (req, res) => {
      try {
        let raw = ""; for await (const chunk of req) raw += String(chunk);
        if (id === "claude-code" && (!req.url?.includes("/messages") || req.url.includes("count_tokens"))) { res.writeHead(200); res.end('{"input_tokens":20}'); return; }
        const body = JSON.parse(raw) as Obj; requests.push({ body, originalEnded });
        if (requests.length > 5) throw new Error("Unexpected model request loop");
        const respond = id === "claude-code" ? anthropic : req.url?.includes("responses") ? responses : chat;
        if (requests.length === 1) respond(res, shellTool(body));
        else respond(res, undefined, `mock turn ${requests.length} completed`);
      } catch (error) { providerError = error; res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const provider = async () => ({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-local-queue-check", model: id === "claude-code" ? "claude-sonnet-4-6" : "deepseek-v4-flash" });
    const repository = new AgentSessionRepository(join(scratch, "data")); await repository.init();
    const config = new AppConfigStore(join(scratch, "data")); await config.init();
    const events: AgentSessionEvent[] = [];
    let liveRun: string | undefined, sessionId = "", queued = false, submitted: Promise<void> | undefined;
    const c = new AgentSessionController(repository, config, (_runtime, sid) => {
      const homeDirectory = join(scratch, "home", sid);
      if (id === "claude-code") return new ClaudeAdapter({ homeDirectory, provider, executable: join(runtimeRoot, "claude/bin/claude") });
      if (id === "codex") return new CodexAdapter({ homeDirectory, provider, executable: join(runtimeRoot, "codex/bin/codex") });
      if (id === "pi") return new PiAdapter({ homeDirectory, provider });
      if (id === "dsh") return new DshAdapter({ homeDirectory, provider, nodeExecutable, entryPoint: join(runtimeRoot, "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"), steeringLoader: join(runtimeRoot, "dsh/steering-loader.mjs") });
      if (id === "qwen-code") return new QwenAdapter({ homeDirectory: prepareQwenTestHome(homeDirectory), provider, nodeExecutable, entryPoint: join(runtimeRoot, "qwen-code/node_modules/@qwen-code/qwen-code/cli-entry.js") });
      return new KimiAdapter({ homeDirectory, provider, nodeExecutable, entryPoint: join(runtimeRoot, "kimi-code/node_modules/@moonshot-ai/kimi-code/dist/main.mjs"), steeringLoader: join(runtimeRoot, "kimi-code/steering-loader.mjs") });
    }, event => {
      events.push(event);
      if (!liveRun && event.phase === "running") liveRun = event.runId;
      if (liveRun && event.runId === liveRun && event.phase === "ready") originalEnded = true;
      if (event.kind === "error") nativeError = event.text;
      if (!queued && (event.kind === "tool" || event.kind === "approval")) {
        queued = true;
        submitted = (async () => {
          await c.enqueue(sessionId, queueMarker);
          await c.enqueue(sessionId, steerMarker);
          const steer = repository.queue(sessionId).messages.find(item => item.text === steerMarker)!;
          await c.steerQueued(sessionId, steer.id);
          if (cancel) await c.cancel(sessionId);
        })();
        void submitted.catch(() => {});
      }
      if (event.kind === "approval" && event.approval) {
        const option = event.approval.options.find(item => item.kind.includes("allow"));
        if (option) void c.respondApproval(sessionId, event.approval.requestId, option.optionId).catch(error => { nativeError = String(error); });
      }
    });
    try {
      sessionId = (await c.create(id, workspace)).id;
      await c.send(sessionId, "先执行 sleep 2，再给出最终回复；这是当前轮次的工具测试。");
      await vi.waitFor(() => {
        if (nativeError) throw new Error(nativeError);
        expect(queued).toBe(true); expect(originalEnded).toBe(true);
        if (!cancel) expect(events.filter(event => event.phase === "ready" && event.runId !== "session")).toHaveLength(2);
      }, { timeout: 25000, interval: 50 });
      await submitted; expect(providerError).toBeUndefined();
      if (!cancel) {
        expect(requests, JSON.stringify(requests.map(r => ({ ended: r.originalEnded, model: r.body.model, last: JSON.stringify((r.body.messages ?? r.body.input)?.at(-1)).slice(0, 900) })))).toHaveLength(3);
        const secondInput = JSON.stringify(requests[1].body.messages ?? requests[1].body.input);
        expect(secondInput).toContain(steerMarker); expect(secondInput).not.toContain(queueMarker);
        expect(requests[1].originalEnded).toBe(false);
        const nextInput = JSON.stringify(requests[2].body.messages ?? requests[2].body.input);
        expect(nextInput).toContain(queueMarker); expect(requests[2].originalEnded).toBe(true);
        const runs = new Set(events.filter(event => event.phase === "running").map(event => event.runId)); expect(runs.size).toBe(2);
        expect(events.filter(event => event.deliveryState === "incorporated")).toHaveLength(2);
        expect(repository.queue(sessionId).messages).toHaveLength(0);
      } else {
        expect(repository.queue(sessionId).paused).toBe(true);
        expect(repository.queue(sessionId).messages.some(item => item.text === queueMarker && item.state === "queued")).toBe(true);
        const count = requests.length; await new Promise(resolve => setTimeout(resolve, 150)); expect(requests).toHaveLength(count);
        expect(events.filter(event => event.kind === "user" && event.deliveryMode === "queue")).toHaveLength(0);
      }
    } finally {
      await c.stopAll(); repository.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  }, 35000);
});
