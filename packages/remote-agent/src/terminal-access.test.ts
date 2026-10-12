import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../../../services/remote-agent/openclaw/plugin";
import { TerminalActivity, activeBrowserAction, isTerminalTool } from "../../../services/remote-agent/openclaw/plugin/terminal-access";
import { inputTerminal, showTerminal, showBrowser } from "../../../services/remote-agent/openclaw/desktop/session.mjs";
import type { RemoteTerminalAccess } from "../../contracts/src/remote-agent";

const task = "c0ec83da-66be-4f17-a2c2-01dc02c89f00", sessionKey = `agent:main:selfme:${task}`;
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), readFile: vi.fn(async () => task), realpath: vi.fn(async path => path) }));
vi.mock("../../../services/remote-agent/openclaw/desktop/session.mjs", () => ({ setTerminalAccess: vi.fn(async () => {}), setDesktopTask: vi.fn(async () => {}), showTerminal: vi.fn(async () => {}), showBrowser: vi.fn(async () => {}), inputTerminal: vi.fn(async () => {}), prepareTerminal: vi.fn(async () => {}), terminalArgv: vi.fn(() => []), disposeTerminal: vi.fn(async () => {}) }));
type Api = Parameters<typeof plugin.register>[0];
type Handler = Parameters<Api["registerGatewayMethod"]>[1];
type Before = (event: { toolName: string; params: Record<string, unknown>; toolKind?: string }, context: { sessionKey: string; runId: string; toolCallId: string; abortSignal?: AbortSignal }) => Promise<void>;
type After = (event: { toolName: string; params: Record<string, unknown> }, context: { sessionKey: string; runId: string; toolCallId: string }) => Promise<void>;
let dispose: (() => Promise<void>) | undefined, stopDesktop: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); await stopDesktop?.(); dispose = undefined; stopDesktop = undefined; vi.clearAllMocks(); });

function fixture() {
  const methods = new Map<string, Handler>(), connection = new AbortController();
  let before!: Before, after!: After;
  const api = {
    agent: { events: { registerAgentEventSubscription() {} } },
    lifecycle: { registerRuntimeLifecycle(value) { dispose = value.dispose; } },
    registerSessionCatalog() {}, registerHttpRoute() {},
    registerGatewayMethod(name, handler) { methods.set(name, handler); },
    on(name: "before_tool_call" | "after_tool_call", handler: Before | After) { if (name === "before_tool_call") before = handler as Before; else after = handler as After; },
  } satisfies Api;
  plugin.register(api);
  const context: Parameters<Handler>[0]["context"] = {
    isTerminalEnabled: () => true, getRuntimeConfig: () => ({}),
    terminalSessions: { list: () => [{ sessionId: "term", cwd: "/home/node/.openclaw/workspace/selfme/" + task }], write: (owner, id) => owner === "owner" && id === "term" },
    hostDesktopService: {
      acquireComputer: async options => { stopDesktop = options.onStop; return { env: { DISPLAY: ":101" }, isCurrent: () => true, release() {} }; },
      observe: vi.fn(async options => ({ wsPath: "/desktop/observe", control: options.control, expiresAtMs: 100 })),
    },
  };
  async function call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, owner = "owner"): Promise<T> {
    let value: unknown, error: string | undefined;
    const handler = methods.get(method); if (!handler) throw new Error("method not registered");
    await handler({ params, context, client: { connId: owner, connectionSignal: connection.signal }, respond(ok, result, problem) { if (ok) value = result; else error = problem?.message ?? "failed"; } });
    if (error) throw new Error(error); return value as T;
  }
  const state = () => call<RemoteTerminalAccess>("selfme.terminal.status", { task });
  const hook = (id: string, tool = "exec", signal?: AbortSignal, kind?: string, params = {}) => before({ toolName: tool, params, toolKind: kind }, { sessionKey, runId: "run", toolCallId: id, abortSignal: signal });
  const finish = (id: string, tool = "exec") => after({ toolName: tool, params: {} }, { sessionKey, runId: "run", toolCallId: id });
  const input = (data: string, id = "term", owner = "owner") => call("selfme.terminal.input", { task, sessionId: id, data }, owner);
  return { methods, context, call, state, hook, finish, input, connection };
}

describe("manual terminal input, without scene takeover", () => {
  it("does not lock input during model thinking, browser calls or outer code-mode orchestration", async () => {
    const f = fixture();
    expect(await f.state()).toEqual({ busy: false, inputAllowed: true });
    await f.hook("browser", "browser"); await f.hook("outer", "exec", undefined, "code_mode_exec");
    expect(await f.state()).toEqual({ busy: false, inputAllowed: true });
    await f.input("pwd\r"); expect(inputTerminal).toHaveBeenCalledWith(task, "pwd\r", expect.any(Function));
    expect(showTerminal).not.toHaveBeenCalled();
  });
  it("briefly protects manual input during terminal tools and releases after every concurrent call ends", async () => {
    const f = fixture(); await f.hook("one"); await f.hook("two");
    expect(await f.state()).toEqual({ busy: true, inputAllowed: false });
    await expect(f.input("pwd\r")).rejects.toThrow("暂不可输入");
    await f.input("\x1b[>0;276;0c"); expect(inputTerminal).not.toHaveBeenCalled();
    await f.finish("one"); expect((await f.state()).busy).toBe(true);
    await f.finish("two"); expect((await f.state()).inputAllowed).toBe(true);
    await f.input("printf ok\r"); expect(showTerminal).not.toHaveBeenCalled();
  });
  it("keeps task, connection and native PTY custody checks", async () => {
    const f = fixture();
    await expect(f.input("pwd", "foreign")).rejects.toThrow("不属于");
    await expect(f.input("pwd", "term", "another-owner")).rejects.toThrow("不属于");
    f.connection.abort(); await expect(f.input("pwd")).rejects.toThrow("不属于");
    await expect(f.state()).rejects.toThrow("已断开");
    expect(inputTerminal).not.toHaveBeenCalled();
  });
  it("keeps the desktop directly operable while a terminal tool runs, without aborting the tool", async () => {
    const f = fixture(); await f.call("selfme.scene.prepare", { task }); await f.hook("work");
    expect(await f.call("selfme.scene.observe", { task })).toMatchObject({ control: true });
    expect((await f.state()).busy).toBe(true);
    expect([...f.methods.keys()].some(name => name.startsWith("selfme.control.") || name.startsWith("selfme.browser."))).toBe(false);
    await f.finish("work");
  });
  it("only native browser actions can foreground Chrome; command execution never opens a terminal window", async () => {
    const f = fixture(); await f.call("selfme.scene.prepare", { task });
    await f.hook("command"); await f.finish("command");
    expect(showTerminal).not.toHaveBeenCalled();
    await f.hook("open", "browser", undefined, undefined, { action: "open" });
    expect(showBrowser).toHaveBeenCalledOnce();
    expect(activeBrowserAction("browser", { action: "screenshot" })).toBe(false);
  });
  it("cleans up admission if native cancellation arrives at the tool boundary", async () => {
    const f = fixture(), signal = new AbortController(); signal.abort(new Error("native canceled"));
    await expect(f.hook("canceled", "exec", signal.signal)).rejects.toThrow("native canceled");
    expect((await f.state()).busy).toBe(false);
  });
});

describe("terminal activity lifecycle", () => {
  it("tracks admitted input only until submission and clears native calls on run termination", async () => {
    const activity = new TerminalActivity(); let finish!: () => void;
    activity.track(new Promise<void>(resolve => { finish = resolve; }));
    let drained = false; const drain = activity.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); finish(); await drain;
    activity.beginTool("run:one", "run"); activity.beginTool("other:two", "other");
    activity.observe({ runId: "run", stream: "lifecycle", data: { phase: "end" } });
    expect(activity.busy).toBe(true);
    activity.observe({ runId: "other", stream: "tool", data: { phase: "result", toolCallId: "two" } });
    expect(activity.busy).toBe(false);
    expect(isTerminalTool("exec", "code_mode_exec")).toBe(false); expect(isTerminalTool("process")).toBe(true);
    activity.dispose();
  });
});
