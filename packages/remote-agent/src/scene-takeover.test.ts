import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../../../services/remote-agent/openclaw/plugin";
import type { RemoteSceneAccess } from "../../contracts/src/remote-agent";
import type { NativeExecutionEvent } from "../../../services/remote-agent/openclaw/desktop/execution.mjs";

const task = "c0ec83da-66be-4f17-a2c2-01dc02c89f00", sessionKey = `agent:main:selfme:${task}`;
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), readFile: vi.fn(async () => "c0ec83da-66be-4f17-a2c2-01dc02c89f00"), realpath: vi.fn(async path => path) }));
vi.mock("../../../services/remote-agent/openclaw/desktop/session.mjs", () => ({ setTerminalControl: vi.fn(async () => {}), setDesktopTask: vi.fn(async () => {}), showTerminal: vi.fn(async () => {}), showBrowser: vi.fn(async () => {}), inputTerminal: vi.fn(async () => {}), prepareTerminal: vi.fn(async () => {}), terminalArgv: vi.fn(() => []), disposeTerminal: vi.fn(async () => {}) }));
vi.mock("../../../services/remote-agent/openclaw/desktop/execution.mjs", () => ({ ExecutionObserver: class { observe() {} async forget() {} async dispose() {} } }));

type Api = Parameters<typeof plugin.register>[0];
type Handler = Parameters<Api["registerGatewayMethod"]>[1];
type Before = (event: { toolName: string; params: Record<string, unknown>; toolKind?: string }, context: { sessionKey: string; runId: string; toolCallId: string; abortSignal?: AbortSignal }) => Promise<void>;
type After = (event: { toolName: string; params: Record<string, unknown> }, context: { sessionKey: string; runId: string; toolCallId: string }) => Promise<void>;
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; vi.useRealTimers(); });

function fixture() {
  const methods = new Map<string, Handler>(), runs = new Map<string, unknown>();
  let before!: Before, after!: After, observe!: (event: NativeExecutionEvent) => void, timeout = 0;
  const connection = new AbortController();
  const api = {
    agent: { events: { registerAgentEventSubscription(value) { observe = value.handle; } } },
    lifecycle: { registerRuntimeLifecycle(value) { dispose = value.dispose; } },
    registerSessionCatalog() {}, registerHttpRoute() {},
    registerGatewayMethod(name, handler) { methods.set(name, handler); },
    on(name: "before_tool_call" | "after_tool_call", handler: Before | After, options?: { priority: number; timeoutMs?: number }) { if (name === "before_tool_call") { before = handler as Before; timeout = options?.timeoutMs ?? 0; } else after = handler as After; },
  } satisfies Api;
  plugin.register(api);
  const context: Parameters<Handler>[0]["context"] = { chatAbortControllers: runs, isTerminalEnabled: () => true, getRuntimeConfig: () => ({}) };
  async function call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, owner = "owner"): Promise<T> {
    let value: unknown, error: string | undefined;
    await methods.get(method)!({ params, context, client: { connId: owner, connectionSignal: connection.signal }, respond(ok, result, problem) { if (ok) value = result; else error = problem?.message ?? "failed"; } });
    if (error) throw new Error(error); return value as T;
  }
  const state = () => call<RemoteSceneAccess>("selfme.scene.status", { task });
  const hook = (id: string, tool = "exec", signal?: AbortSignal, toolKind?: string) => before({ toolName: tool, params: {}, toolKind }, { sessionKey, runId: "run", toolCallId: id, abortSignal: signal });
  const finish = (id: string, tool = "exec") => after({ toolName: tool, params: {} }, { sessionKey, runId: "run", toolCallId: id });
  return { call, state, hook, finish, observe, runs, connection, timeout };
}

describe("actual OpenClaw plugin takeover hooks", () => {
  it("lets the admitted operation finish, holds the next original call beyond the native 15s default and resumes once", async () => {
    const f = fixture(); f.runs.set("run", {});
    await f.hook("current");
    expect(await f.state()).toMatchObject({ agentBusy: true, terminalBusy: true, terminalInputAllowed: false, browserInputAllowed: true });
    const lease = await f.call("selfme.control.acquire", { task });
    expect(await f.state()).toMatchObject({ takeover: "waiting", humanControl: false, inputAllowed: false });
    let nextRuns = 0;
    const next = f.hook("next").then(() => { nextRuns++; });
    await f.finish("current");
    expect(await f.state()).toMatchObject({ agentBusy: true, takeover: "ready", humanControl: true, terminalInputAllowed: true });
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(16_000);
    expect(nextRuns).toBe(0); expect(f.timeout).toBeGreaterThan(15_000); expect(f.runs.has("run")).toBe(true);
    await f.call("selfme.control.release", { id: lease.id }); await next;
    expect(nextRuns).toBe(1); expect(await f.state()).toMatchObject({ takeover: "none", terminalBusy: true, browserInputAllowed: true });
    await f.finish("next");
  });
  it("does not count outer code-mode orchestration against the paused nested call", async () => {
    const f = fixture(); await f.hook("outer", "exec", undefined, "code_mode_exec");
    const lease = await f.call("selfme.control.acquire", { task });
    expect((await f.state()).takeover).toBe("ready");
    const next = f.hook("inner", "browser");
    expect((await f.state()).browserBusy).toBe(false);
    await f.call("selfme.control.release", { id: lease.id }); await next;
    expect((await f.state()).browserBusy).toBe(true); await f.finish("inner", "browser");
  });
  it("grants forced control only after native cancellation actually retires", async () => {
    const f = fixture(); f.runs.set("run", {}); const cancellation = new AbortController();
    await f.hook("current"); const lease = await f.call("selfme.control.acquire", { task });
    const queued = f.hook("next", "browser", cancellation.signal); const rejected = expect(queued).rejects.toThrow("native aborted");
    await f.call("selfme.control.force", { id: lease.id });
    expect(await f.state()).toMatchObject({ takeover: "stopping", inputAllowed: false });
    cancellation.abort(new Error("native aborted")); await rejected; await f.finish("current");
    expect((await f.state()).takeover).toBe("stopping");
    f.runs.clear(); f.observe({ runId: "run", stream: "lifecycle", ts: Date.now(), data: { phase: "end" } });
    expect(await f.state()).toMatchObject({ takeover: "ready", inputAllowed: true });
    await f.call("selfme.control.release", { id: lease.id });
    expect((await f.state()).browserBusy).toBe(false);
  });
  it("preserves independent resource gates and authenticated lease ownership", async () => {
    const f = fixture(); await f.hook("browser", "browser");
    expect(await f.state()).toMatchObject({ browserInputAllowed: false, terminalInputAllowed: true, inputAllowed: true });
    await expect(f.call("selfme.browser.open", { task })).rejects.toThrow("正在操作浏览器");
    const lease = await f.call("selfme.control.acquire", { task });
    await expect(f.call("selfme.control.force", { id: lease.id }, "other")).rejects.toThrow("不属于此连接");
    await expect(f.call("selfme.control.release", { id: lease.id }, "other")).rejects.toThrow("不属于此连接");
    await f.finish("browser", "browser");
    expect((await f.state()).takeover).toBe("ready"); f.connection.abort();
    const paused = new AbortController(); paused.abort(new Error("expired"));
    await expect(f.hook("expired", "exec", paused.signal)).rejects.toThrow("expired");
  });
  it("does not admit canceled calls after a held native run expires", async () => {
    const f = fixture(), cancellation = new AbortController();
    const lease = await f.call("selfme.control.acquire", { task });
    const pending = f.hook("expired", "exec", cancellation.signal); const rejected = expect(pending).rejects.toThrow("deadline");
    cancellation.abort(new Error("deadline")); await rejected;
    await f.call("selfme.control.release", { id: lease.id });
    expect(await f.state()).toMatchObject({ takeover: "none", terminalBusy: false, browserBusy: false });
  });
});
