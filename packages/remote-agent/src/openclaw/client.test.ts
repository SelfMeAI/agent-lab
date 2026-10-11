import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { RemoteTaskSnapshot, RemoteTerminalEvent } from "../../../contracts/src/remote-agent";
import { OpenClawTasks, clawTask } from "./client";
import { RemoteHttp } from "../transport/http";
import { OpenClawConnection, type GatewayEvent } from "./connection";
import { createOpenClawIdentity } from "./gateway";

const id = "agent:main:selfme:c0ec83da-66be-4f17-a2c2-01dc02c89f00";
const message = (value: string) => ({ role: "user", content: value, __openclaw: { id: value } });
function fixture() {
  const updates: RemoteTaskSnapshot[] = [], terminalEvents: RemoteTerminalEvent[] = [];
  const client = new OpenClawTasks(new RemoteHttp("openclaw", async () => "http://127.0.0.1:1234", async () => "private-token"), async () => ({ sessionApiKey: "private-token" }), update => updates.push(update), update => terminalEvents.push(update));
  const request = vi.spyOn(client, "request").mockImplementation(async (method: string) => {
    if (method === "sessions.list") return { sessions: [{ key: id, displayName: "新任务", status: "idle" }] };
    if (method === "chat.history") return { messages: [message("tail")], hasMore: false, pagination: { rawPageMessages: 1 } };
    if (method === "question.list") return { questions: [] };
    if (method === "selfme.scene.prepare") return { root: "/home/node/.openclaw/workspace/selfme/c0ec83da-66be-4f17-a2c2-01dc02c89f00", display: ":101" };
    return {};
  });
  const event = (frame: GatewayEvent) => (client as unknown as { event(frame: GatewayEvent): void }).event(frame);
  return { client, request, updates, terminalEvents, event };
}
afterEach(() => vi.restoreAllMocks());
describe("OpenClaw native task projections and custody", () => {
  it("uses automatic native presentation names instead of a global unique alias", () => {
    expect(clawTask({ key: id, displayName: "新任务", autoLabel: "真实任务" }).title).toBe("真实任务");
    expect(clawTask({ key: id, label: "用户命名", autoLabel: "自动标题" }).title).toBe("用户命名");
  });
  it("preserves earlier pages while the live tail is refreshed", async () => {
    const { client, request, updates, event } = fixture();
    request.mockImplementation(async (method: string, params: unknown) => {
      if (method === "sessions.list") return { sessions: [{ key: id }] };
      if (method === "chat.history") return (params as { offset: number }).offset ? { messages: [message("older")], hasMore: false, nextOffset: 2, pagination: { rawPageMessages: 1 } } : { messages: [message("tail")], hasMore: true, nextOffset: 1, pagination: { rawPageMessages: 1 } };
      if (method === "question.list") return { questions: [] }; return {};
    });
    await client.open(id); expect((await client.earlier(id)).items.map(item => item.text)).toEqual(["older", "tail"]);
    event({ event: "session.message", payload: { sessionKey: id } });
    await vi.waitFor(() => expect(request.mock.calls.filter(([name]) => name === "chat.history")).toHaveLength(3));
    expect(updates.at(-1)?.items.map(item => item.text)).toEqual(["older", "tail"]); expect(updates.at(-1)?.hasEarlier).toBe(false); client.shutdown();
  });
  it("keeps loaded tail rows and advances older offsets when new messages arrive", async () => {
    const { client, request, event, updates } = fixture(); let tailReads = 0;
    request.mockImplementation(async (method, params: unknown) => {
      if (method === "sessions.list") return { sessions: [{ key: id }] };
      if (method === "question.list") return { questions: [] };
      if (method !== "chat.history") return {};
      const offset = (params as { offset: number }).offset;
      if (offset === 1) return { messages: [message("older")], totalMessages: 3, nextOffset: 2, hasMore: true };
      if (offset === 3) return { messages: [message("oldest")], totalMessages: 4, hasMore: false };
      return ++tailReads === 1 ? { messages: [message("tail")], totalMessages: 3, nextOffset: 1, hasMore: true } : { messages: [message("new")], totalMessages: 4, nextOffset: 1, hasMore: true };
    });
    await client.open(id); await client.earlier(id); event({ event: "session.message", payload: { sessionKey: id } });
    await vi.waitFor(() => expect(updates.at(-1)?.items.map(item => item.text)).toEqual(["older", "tail", "new"]));
    expect((await client.earlier(id)).items.map(item => item.text)).toEqual(["oldest", "older", "tail", "new"]);
    expect(request).toHaveBeenCalledWith("chat.history", expect.objectContaining({ offset: 3 })); client.shutdown();
  });
  it("does not resurrect a view whose open request completed after close", async () => {
    const { client, request, updates } = fixture(); let finish!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const opening = client.open(id); await vi.waitFor(() => expect(finish).toBeDefined()); await client.close(id);
    finish({ sessions: [{ key: id }] }); await expect(opening).rejects.toThrow("视图已关闭"); expect(updates).toHaveLength(0); client.shutdown();
  });
  it("shares one authenticated connection while simultaneous callers load credentials", async () => {
    let finish!: (value: { sessionApiKey: string; device: ReturnType<typeof createOpenClawIdentity> }) => void;
    const credentials = vi.fn(() => new Promise<{ sessionApiKey: string; device: ReturnType<typeof createOpenClawIdentity> }>(resolve => { finish = resolve; }));
    const client = new OpenClawTasks(new RemoteHttp("openclaw", async () => "http://127.0.0.1:1234", async () => "token"), credentials, () => {}, () => {});
    vi.spyOn(OpenClawConnection.prototype, "connect").mockResolvedValue();
    const receivers: OpenClawConnection[] = [];
    vi.spyOn(OpenClawConnection.prototype, "request").mockImplementation(async function (this: OpenClawConnection) { receivers.push(this); return {}; });
    const calls = [client.request("first"), client.request("second")]; expect(credentials).toHaveBeenCalledTimes(1);
    finish({ sessionApiKey: "token", device: createOpenClawIdentity() }); await Promise.all(calls);
    expect(receivers).toHaveLength(2); expect(receivers[0]).toBe(receivers[1]); client.shutdown();
  });
  it("does not recreate a connection from credentials that resolved after shutdown", async () => {
    let finish!: (value: { sessionApiKey: string; device: ReturnType<typeof createOpenClawIdentity> }) => void;
    const client = new OpenClawTasks(new RemoteHttp("openclaw", async () => "http://127.0.0.1:1234", async () => "token"), () => new Promise(resolve => { finish = resolve; }), () => {}, () => {});
    const connect = vi.spyOn(OpenClawConnection.prototype, "connect").mockResolvedValue();
    const pending = client.request("test"); client.shutdown(); finish({ sessionApiKey: "token", device: createOpenClawIdentity() });
    await expect(pending).rejects.toThrow("连接已关闭"); expect(connect).not.toHaveBeenCalled();
  });
  it("replays the nested native call AND receipt rather than leaving it running", async () => {
    const { client, request } = fixture();
    request.mockImplementation(async (method: string) => {
      if (method === "sessions.list") return { sessions: [{ key: id }] };
      if (method === "question.list") return { questions: [] };
      if (method === "chat.history") return { messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "outer", name: "tool_call", arguments: { id: "openclaw:browser:browser", args: { action: "open", url: "https://example.com" } } }] },
        { role: "custom", content: [{ type: "toolCall", id: "inner", name: "browser", parentToolCallId: "outer", arguments: { action: "open", url: "https://example.com" } }, { type: "toolResult", toolCallId: "inner", toolName: "browser", parentToolCallId: "outer", isError: false, content: [{ text: "Page opened" }] }] },
        { role: "toolResult", toolCallId: "outer", toolName: "tool_call", content: [{ text: "wrapper result" }] },
      ] }; return {};
    });
    const snapshot = await client.open(id), tools = snapshot.items.filter(item => item.tool);
    expect(tools).toHaveLength(1); expect(tools[0]).toMatchObject({ id: "live:inner", tool: { name: "browser", status: "completed", output: "Page opened" } }); client.shutdown();
  });
  it("does not regress an already completed native tool on delayed start/update", async () => {
    const { client, updates, event } = fixture(); await client.open(id);
    event({ event: "session.tool", payload: { sessionKey: id, data: { phase: "start", name: "exec", toolCallId: "call", args: { command: "pwd" } } } });
    event({ event: "session.tool", payload: { sessionKey: id, data: { phase: "result", name: "exec", toolCallId: "call", result: { content: [{ text: "path" }] } } } });
    event({ event: "session.tool", payload: { sessionKey: id, data: { phase: "start", name: "exec", toolCallId: "call" } } });
    expect(updates.at(-1)?.items.find(item => item.id === "live:call")?.tool).toMatchObject({ status: "completed", output: "path" }); client.shutdown();
  });
  it("does not append old failed tools after a newer bounded history tail", async () => {
    const { client, request, updates, event } = fixture(); let latest = false;
    const older = [
      { role: "assistant", timestamp: "2026-10-10T03:10:00Z", content: [{ type: "toolCall", id: "old-browser", name: "browser", arguments: { action: "screenshot" } }] },
      { role: "toolResult", toolCallId: "old-browser", toolName: "browser", timestamp: "2026-10-10T03:10:20Z", isError: true, content: [{ type: "text", text: "Browser not running" }] },
    ];
    request.mockImplementation(async (method, params: unknown) => {
      if (method === "sessions.list") return { sessions: [{ key: id, status: "done" }] };
      if (method === "chat.history") return latest && !(params as { offset: number }).offset ? { messages: [{ ...message("new"), timestamp: "2026-10-10T05:59:00Z" }], hasMore: true, nextOffset: 1 } : { messages: older, hasMore: false, nextOffset: 3 };
      if (method === "question.list") return { questions: [] }; return {};
    });
    expect((await client.open(id)).items[0]?.tool?.status).toBe("failed");
    latest = true; event({ event: "session.message", payload: { sessionKey: id } });
    await vi.waitFor(() => expect(updates.at(-1)?.items.map(item => item.id)).toEqual(["new"]));
    expect(updates.at(-1)?.hasEarlier).toBe(true);
    const loaded = await client.earlier(id);
    expect(loaded.items[0]).toMatchObject({ id: "live:old-browser", tool: { status: "failed" } });
    expect(loaded.items.at(-1)?.id).toBe("new"); client.shutdown();
  });
  it("keeps a recent live receipt in chronological position while native persistence catches up", async () => {
    const { client, request, updates, event } = fixture(); let latest = false;
    request.mockImplementation(async method => {
      if (method === "sessions.list") return { sessions: [{ key: id }] };
      if (method === "chat.history") return { messages: [{ ...message("tail"), timestamp: "2026-10-10T06:00:00Z" }, ...(latest ? [{ ...message("new"), timestamp: "2026-10-10T06:00:05Z" }] : [])], hasMore: false };
      if (method === "question.list") return { questions: [] }; return {};
    });
    await client.open(id);
    event({ event: "session.tool", payload: { sessionKey: id, ts: "2026-10-10T06:00:01Z", data: { phase: "start", name: "browser", toolCallId: "recent" } } });
    event({ event: "session.tool", payload: { sessionKey: id, ts: "2026-10-10T06:00:02Z", data: { phase: "result", name: "browser", toolCallId: "recent", result: { content: [{ text: "Page opened" }] } } } });
    latest = true; event({ event: "session.message", payload: { sessionKey: id } });
    await vi.waitFor(() => expect(updates.at(-1)?.items.map(item => item.id)).toEqual(["tail", "live:recent", "new"]));
    expect(updates.at(-1)?.items[1]?.tool).toMatchObject({ status: "completed", output: "Page opened" }); client.shutdown();
  });
  it("retains output position on deltas while mid-run user messages arrive", async () => {
    const { client, updates, event } = fixture(); await client.open(id);
    event({ event: "chat", payload: { sessionKey: id, runId: "run", state: "delta", deltaText: "a" } });
    event({ event: "session.tool", payload: { sessionKey: id, data: { phase: "start", name: "exec", toolCallId: "tool" } } });
    event({ event: "chat", payload: { sessionKey: id, runId: "run", state: "delta", deltaText: "b" } });
    expect(updates.at(-1)?.items.map(item => item.id)).toEqual(["tail", "stream:run", "live:tool"]); expect(updates.at(-1)?.items[1].text).toBe("ab"); client.shutdown();
  });
  it("resolves only a live native approval belonging to the selected task", async () => {
    const { client, request, event } = fixture(); await client.open(id);
    await expect(client.approve(id, "unknown", "always")).rejects.toThrow("审批");
    event({ event: "session.approval", payload: { sessionKey: id, phase: "pending", approval: { id: "approval", presentation: { kind: "exec", commandText: "pwd" } } } });
    await client.approve(id, "approval", "always"); expect(request).toHaveBeenCalledWith("approval.resolve", { id: "approval", kind: "exec", decision: "allow-always" }); client.shutdown();
  });
  it("stops the native session without withdrawing an unrelated queued input run", async () => {
    const { client, request } = fixture(); await client.control(id, "stop");
    expect(request).toHaveBeenCalledWith("chat.abort", { sessionKey: id }); client.shutdown();
  });
  it("starts ordinary turns when idle or paused, and steers only a live task", async () => {
    const { client, request, event } = fixture(); await client.open(id);
    await client.send(id, "start");
    const first = request.mock.calls.find(([name]) => name === "selfme.scene.send")?.[1];
    expect(first).toMatchObject({ sessionKey: id, message: "start" });
    expect(first).not.toHaveProperty("queueMode"); expect(first).not.toHaveProperty("timeoutMs");
    await client.send(id, "supplement");
    expect(request).toHaveBeenCalledWith("selfme.scene.send", expect.objectContaining({ queueMode: "steer", message: "supplement" }));
    event({ event: "chat", payload: { sessionKey: id, state: "aborted" } });
    await client.send(id, "retry");
    const retry = request.mock.calls.filter(([name]) => name === "selfme.scene.send").at(-1)?.[1];
    expect(retry).not.toHaveProperty("queueMode"); client.shutdown();
  });
  it("restores the failed native turn on reopen and starts a new turn without losing history", async () => {
    const { client, request, updates } = fixture();
    request.mockImplementation(async method => {
      if (method === "sessions.list") return { sessions: [{ key: id, status: "failed" }] };
      if (method === "chat.history") return { messages: [message("task"), { id: "native-failure", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Provider returned an incomplete or malformed tool call", __openclaw: { runId: "failed" } } }] };
      if (method === "question.list") return { questions: [] }; return {};
    });
    const snapshot = await client.open(id);
    expect(snapshot.task.status).toBe("error"); expect(snapshot.error).toBeUndefined();
    expect(snapshot.items.at(-1)).toMatchObject({ id: "native-failure", failure: { runId: "failed" } });
    expect(snapshot.failure?.message).toContain("malformed tool call");
    await client.close(id); expect((await client.open(id)).failure).toEqual(snapshot.failure);
    await client.send(id, "Continue after checking existing files");
    expect(request).toHaveBeenCalledWith("selfme.scene.send", expect.objectContaining({ sessionKey: id, message: "Continue after checking existing files" }));
    expect(request.mock.calls.filter(([name]) => name === "selfme.scene.send").at(-1)?.[1]).not.toHaveProperty("queueMode");
    expect(updates.at(-1)?.task.status).toBe("running"); expect(updates.at(-1)?.failure).toBeUndefined();
    expect(updates.at(-1)?.items.at(-1)?.failure).toBeDefined(); client.shutdown();
  });
  it("keeps live execution failure out of the connection banner and replaces it with durable history", async () => {
    const { client, request, event, updates } = fixture(); await client.open(id);
    event({ event: "chat", payload: { sessionKey: id, runId: "failed", state: "error", errorMessage: "API Error: 524", ts: "2026-10-10T04:17:39Z" } });
    expect(updates.at(-1)).toMatchObject({ connection: "connected", failure: { message: "API Error: 524", runId: "failed" } });
    expect(updates.at(-1)?.error).toBeUndefined();
    request.mockImplementation(async method => method === "chat.history" ? { sessionInfo: { status: "failed" }, messages: [message("task"), { id: "durable-error", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "API Error: 524", __openclaw: { runId: "failed" } } }] } : {});
    await vi.waitFor(() => expect(updates.at(-1)?.items.at(-1)?.id).toBe("durable-error"));
    expect(updates.at(-1)?.items.filter(item => item.failure)).toHaveLength(1); expect(updates.at(-1)?.error).toBeUndefined(); client.shutdown();
  });
  it("keeps the live reason when native history strips diagnostics, without inventing a reason on reopen", async () => {
    const { client, request, event, updates } = fixture(); await client.open(id);
    event({ event: "chat", payload: { sessionKey: id, runId: "failed", state: "error", errorMessage: "Provider returned an incomplete or malformed tool call", ts: "2026-10-10T04:17:39Z" } });
    request.mockImplementation(async method => method === "sessions.list" ? { sessions: [{ key: id, status: "failed" }] } : method === "chat.history" ? { sessionInfo: { status: "failed" }, messages: [message("task"), { id: "durable-error", message: { role: "assistant", content: [{ type: "text", text: "Partial work already done" }], stopReason: "error", __openclaw: { runId: "failed" } } }] } : {});
    await vi.waitFor(() => expect(updates.at(-1)?.items.at(-1)?.id).toBe("durable-error"));
    expect(updates.at(-1)?.items.at(-1)).toMatchObject({ text: "Partial work already done", failure: { message: "Provider returned an incomplete or malformed tool call" } });
    event({ event: "session.message", payload: { sessionKey: id } });
    await vi.waitFor(() => expect(request.mock.calls.filter(([name]) => name === "chat.history")).toHaveLength(3));
    expect(updates.at(-1)?.failure?.message).toContain("malformed tool call");
    await client.close(id); const reopened = await client.open(id);
    expect(reopened.task.status).toBe("error"); expect(reopened.failure?.message).toBe("");
    expect(reopened.items.at(-1)?.text).toBe("Partial work already done"); client.shutdown();
  });
  it("does not attribute a different run's live reason to a historical failure", async () => {
    const { client, request, event, updates } = fixture(); await client.open(id);
    event({ event: "chat", payload: { sessionKey: id, runId: "new-run", state: "error", errorMessage: "API Error: 524" } });
    request.mockImplementation(async method => method === "chat.history" ? { sessionInfo: { status: "failed" }, messages: [message("task"), { id: "old-error", message: { role: "assistant", content: [], stopReason: "error", __openclaw: { runId: "old-run" } } }] } : {});
    await vi.waitFor(() => expect(updates.at(-1)?.items.at(-1)?.id).toBe("old-error"));
    expect(updates.at(-1)?.items.at(-1)?.failure?.message).toBe("");
    expect(updates.at(-1)?.failure).toMatchObject({ runId: "new-run", message: "API Error: 524" }); client.shutdown();
  });
  it("projects native questions including Other and cancels without fabricating answers", async () => {
    const { client, request, event, updates } = fixture(); await client.open(id);
    event({ event: "question.requested", payload: { sessionKey: id, id: "question", status: "pending", questions: [{ questionId: "q", header: "方案", question: "选择方案", options: [{ label: "A", description: "描述" }], multiSelect: false, isOther: true }] } });
    expect(updates.at(-1)?.items.find(item => item.question)?.question?.questions[0]).toMatchObject({ id: "q", other: true, options: [{ label: "A", description: "描述" }] });
    await client.answer(id, "question", null); expect(request).toHaveBeenCalledWith("question.resolve", { id: "question", cancel: true }); client.shutdown();
  });
  it("binds PTY actions to the task and deduplicates the attached buffer's sequence", async () => {
    const { client, request, event, terminalEvents } = fixture();
    request.mockImplementation(async method => method === "selfme.scene.prepare" ? { root: "/home/node/.openclaw/workspace/selfme/c0ec83da-66be-4f17-a2c2-01dc02c89f00" } : method === "terminal.open" ? { sessionId: "term", cwd: "/home/node/.openclaw/workspace/selfme/c0ec83da-66be-4f17-a2c2-01dc02c89f00", confined: false } : method === "terminal.attach" ? { buffer: "initial", seq: 7 } : {});
    expect(await client.terminal(id)).toMatchObject({ id: "term", buffer: "initial" });
    expect(request).not.toHaveBeenCalledWith("selfme.terminal.prepare", expect.anything());
    expect(request).toHaveBeenCalledWith("terminal.open", { cols: 100, rows: 30, catalog: { catalogId: "selfme-lab-terminal", hostId: "gateway", threadId: "c0ec83da-66be-4f17-a2c2-01dc02c89f00" } });
    expect(request).not.toHaveBeenCalledWith("terminal.input", expect.anything());
    event({ event: "terminal.data", payload: { sessionId: "term", seq: 7, data: "initial" } });
    event({ event: "terminal.data", payload: { sessionId: "term", seq: 8, data: "next" } });
    expect(terminalEvents).toHaveLength(1); expect(terminalEvents[0].data).toBe("next");
    await expect(client.terminalInput(id.replace("c0ec", "a0ec"), "term", "pwd")).rejects.toThrow("不属于"); client.shutdown();
  });
  it("never launches a browser implicitly when observing an empty task", async () => {
    const { client, request } = fixture();
    request.mockImplementation(async (_method, params: unknown) => (params as { path?: string })?.path === "/tabs" ? { tabs: [] } : {});
    await expect(client.browser(id)).rejects.toThrow("没有打开浏览器页面");
    expect(request.mock.calls.some(([, params]) => ["/tabs/open", "/tabs/focus", "/screencast"].includes((params as { path?: string })?.path ?? ""))).toBe(false);
    client.shutdown();
  });
  it("opens a real task-owned page only on explicit navigation, on the prepared desktop", async () => {
    const { client, request } = fixture(); let opened = false;
    request.mockImplementation(async (method, params: unknown) => {
      if (method === "selfme.scene.prepare") return { display: ":101" };
      if (method === "selfme.control.acquire") return { id: "lease" };
      if (method === "selfme.scene.observe") return { wsPath: "/desktop/observe", control: true, scene: { agentBusy: false, humanControl: true, inputAllowed: true } };
      if (method === "selfme.browser.open") { opened = true; return { targetId: "owned" }; }
      const request = params as { path?: string; body?: { url?: string } };
      if (request.path === "/tabs/open") { opened = true; return { targetId: "owned" }; }
      if (request.path === "/tabs") return { tabs: opened ? [{ targetId: "owned", title: "test", url: "about:blank" }] : [] };
      if (request.path === "/screencast") return { wsPath: "/browser/observe?token=one-use", url: "about:blank", expiresAtMs: 100 };
      return {};
    });
    await client.desktop(id, true); request.mockClear();
    expect(await client.browser(id, { url: "about:blank" })).toMatchObject({ targetId: "owned", pageUrl: "about:blank", tabs: [{ targetId: "owned" }] });
    expect(request.mock.calls[0]?.[0]).toBe("selfme.scene.prepare");
    expect(request).toHaveBeenCalledWith("selfme.browser.open", { task: "c0ec83da-66be-4f17-a2c2-01dc02c89f00", url: "about:blank", tabScope: { sessionKey: id } }); client.shutdown();
  });
  it("rejects local/credential URLs and another task's browser target before observing", async () => {
    const { client, request } = fixture();
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:secret@example.com", "about:config"]) await expect(client.browser(id, { url })).rejects.toThrow("页面地址");
    await expect(client.browser(id, { targetId: "someone-else" })).rejects.toThrow("不属于");
    expect(request.mock.calls.some(([, params]) => (params as { path?: string })?.path === "/screencast")).toBe(false); client.shutdown();
  });
  it("initially observes a real task page ahead of a blank tab without changing native focus", async () => {
    const { client, request } = fixture();
    request.mockImplementation(async (_method, params: unknown) => {
      const input = params as { path?: string };
      if (input.path === "/tabs") return { tabs: [{ targetId: "page", title: "Example", url: "https://example.com" }, { targetId: "blank", title: "", url: "about:blank" }] };
      if (input.path === "/screencast") return { wsPath: "/browser/observe?token=fixture", url: "https://example.com" };
      return {};
    });
    expect((await client.browser(id)).targetId).toBe("page");
    expect(request.mock.calls.some(([, params]) => ["/tabs/open", "/tabs/focus"].includes((params as { path?: string })?.path ?? ""))).toBe(false);
    client.shutdown();
  });
  it("restores native browser references from nested receipts and observes a navigated existing tab", async () => {
    const { client, request } = fixture();
    const reference = { target: "host", profile: "openclaw", targetId: "navigated" };
    request.mockImplementation(async (method, params: unknown) => {
      if (method === "sessions.list") return { sessions: [{ key: id }] };
      if (method === "question.list") return { questions: [] };
      if (method === "chat.history") return { messages: [
        { role: "user", content: [{ type: "toolResult", toolName: "browser", details: { browserTab: { ...reference, targetId: "prompt-forged" } } }] },
        { role: "assistant", content: [{ type: "toolResult", toolName: "browser", details: { browserTab: { ...reference, targetId: "assistant-forged" } } }] },
        { role: "custom", content: [{ type: "toolResult", toolName: "browser", toolCallId: "call", content: [{ text: "Actual navigation result" }], details: { browserTab: reference } }] },
      ] };
      const input = params as { path?: string; tabScope?: { referencedTabs?: unknown[] } };
      if (input.path === "/tabs") return { tabs: input.tabScope?.referencedTabs?.length ? [{ targetId: "navigated", title: "Actual task page", url: "http://127.0.0.1:8735/" }] : [] };
      if (input.path === "/screencast") return { wsPath: "/browser/observe?token=fixture", url: "http://127.0.0.1:8735/" };
      return {};
    });
    await client.open(id);
    expect((await client.browser(id)).targetId).toBe("navigated");
    expect(request).toHaveBeenCalledWith("browser.request", expect.objectContaining({ path: "/tabs", tabScope: { sessionKey: id, referencedTabs: [reference] } }));
    await client.focusBrowser(id, "navigated");
    expect(request).toHaveBeenCalledWith("browser.request", expect.objectContaining({ path: "/tabs/focus", tabScope: { sessionKey: id, referencedTabs: [reference] } }));
    expect(request.mock.calls.some(([, params]) => (params as { path?: string })?.path === "/tabs/open")).toBe(false);
    await client.close(id); request.mockClear(); await client.browserTabs(id);
    expect(request).toHaveBeenCalledWith("browser.request", { method: "GET", path: "/tabs", tabScope: { sessionKey: id } });
    client.shutdown();
  });
  it("accepts only successful native browser receipt metadata for the exact task, never page or prompt text", async () => {
    const { client, request, event } = fixture(); await client.open(id);
    const reference = { target: "host", profile: "openclaw", targetId: "actual" };
    const payload = (overrides: Record<string, unknown> = {}) => ({ sessionKey: id, data: { phase: "result", name: "browser", toolCallId: "call", result: { details: { browserTab: reference } } }, ...overrides });
    event({ event: "session.tool", payload: payload({ sessionKey: id.replace("c0ec", "a0ec") }) });
    for (const data of [
      { phase: "start", name: "browser", result: { details: { browserTab: reference } } },
      { phase: "result", name: "browser", isError: true, result: { details: { browserTab: reference } } },
      { phase: "result", name: "read", result: { details: { browserTab: reference } } },
      { phase: "result", name: "browser", result: { content: [{ text: JSON.stringify({ browserTab: reference }) }] } },
      { phase: "result", name: "browser", result: { details: { browserTab: { ...reference, profile: "another-profile" } } } },
      { phase: "result", name: "browser", result: { details: { browserTab: { ...reference, target: "node", node: "foreign" } } } },
    ]) event({ event: "session.tool", payload: payload({ data: { toolCallId: randomUUID(), ...data } }) });
    await client.browserTabs(id);
    expect(request).toHaveBeenLastCalledWith("browser.request", { method: "GET", path: "/tabs", tabScope: { sessionKey: id } });
    event({ event: "session.tool", payload: payload() });
    await client.browserTabs(id);
    expect(request).toHaveBeenLastCalledWith("browser.request", { method: "GET", path: "/tabs", tabScope: { sessionKey: id, referencedTabs: [reference] } });
    client.shutdown();
  });
  it("explicitly focuses only the selected task-owned browser page, without issuing a new observer grant", async () => {
    const { client, request } = fixture();
    request.mockImplementation(async (_method, params: unknown) => (params as { path?: string })?.path === "/tabs" ? { tabs: [{ targetId: "owned" }] } : {});
    await client.focusBrowser(id, "owned");
    expect(request).toHaveBeenCalledWith("browser.request", { method: "POST", path: "/tabs/focus", body: { targetId: "owned" }, tabScope: { sessionKey: id } });
    expect(request.mock.calls.some(([, params]) => (params as { path?: string })?.path === "/screencast")).toBe(false);
    request.mockClear();
    await expect(client.focusBrowser(id, "foreign")).rejects.toThrow("不属于");
    await expect(client.focusBrowser(id, "")).rejects.toThrow("标识");
    expect(request.mock.calls.some(([, params]) => (params as { path?: string })?.path === "/tabs/focus")).toBe(false);
    client.shutdown();
  });
  it("holds tools and stops native work before takeover, keeping window location available in the same controlled task", async () => {
    const { client, request } = fixture(); let running = true;
    request.mockImplementation(async (method: string, params: unknown) => {
      if (method === "sessions.list") return { sessions: [{ key: id, status: running ? "running" : "idle" }] };
      if (method === "selfme.control.acquire") return { id: "lease" };
      if (method === "chat.abort") running = false;
      if (method === "selfme.scene.observe") return { wsPath: "/desktop/observe?token=fixture", control: true, scene: { agentBusy: false, humanControl: true, inputAllowed: true } };
      if ((params as { path?: string })?.path === "/tabs") return { tabs: [{ targetId: "owned" }] };
      return {};
    });
    await client.desktop(id, true);
    const names = request.mock.calls.map(([name]) => name);
    expect(names.indexOf("selfme.control.acquire")).toBeLessThan(names.indexOf("chat.abort"));
    expect(names.indexOf("chat.abort")).toBeLessThan(names.indexOf("selfme.control.ready"));
    expect(names.indexOf("selfme.control.ready")).toBeLessThan(names.indexOf("selfme.scene.observe"));
    await client.focusBrowser(id, "owned");
    expect(request).toHaveBeenCalledWith("browser.request", expect.objectContaining({ path: "/tabs/focus", body: { targetId: "owned" } }));
    await expect(client.focusBrowser(id.replace("c0ec", "a0ec"), "owned")).rejects.toThrow("其他任务");
    await client.release();
    expect(request).toHaveBeenCalledWith("selfme.control.release", { id: "lease" });
    await client.focusBrowser(id, "owned"); client.shutdown();
  });
  it("routes idle browser input through server admission, without creating a takeover", async () => {
    const { client, request } = fixture();
    request.mockImplementation(async (method, params: unknown) => {
      if (method === "selfme.browser.open") return { targetId: "owned" };
      if ((params as { path?: string })?.path === "/tabs") return { tabs: [{ targetId: "owned" }] };
      if ((params as { path?: string })?.path === "/screencast") return { wsPath: "/browser/observe", url: "about:blank" };
      return {};
    });
    const events = [{ kind: "text", text: "你好" }] as const;
    await client.browserInput(id, "owned", [...events]);
    expect(request).toHaveBeenCalledWith("selfme.browser.input", { task: "c0ec83da-66be-4f17-a2c2-01dc02c89f00", targetId: "owned", events, tabScope: { sessionKey: id } });
    await client.browser(id, { url: "about:blank" });
    expect(request).not.toHaveBeenCalledWith("selfme.control.acquire", expect.anything());
    request.mockImplementation(async method => { if (method === "selfme.browser.input") throw new Error("智能体正在工作"); return {}; });
    await expect(client.browserInput(id, "owned", [...events])).rejects.toThrow("正在工作");
    client.shutdown();
  });
  it("keeps terminal custody validation while letting the server distinguish idle and running", async () => {
    const { client, request } = fixture();
    request.mockImplementation(async method => method === "selfme.scene.prepare" ? { root: "/home/node/.openclaw/workspace/selfme/c0ec83da-66be-4f17-a2c2-01dc02c89f00" } : method === "terminal.open" ? { sessionId: "term", cwd: "/home/node/.openclaw/workspace/selfme/c0ec83da-66be-4f17-a2c2-01dc02c89f00" } : {});
    await client.terminal(id); await client.terminalInput(id, "term", "pwd\r");
    expect(request).toHaveBeenCalledWith("selfme.terminal.input", { task: "c0ec83da-66be-4f17-a2c2-01dc02c89f00", sessionId: "term", data: "pwd\r" });
    await expect(client.terminalInput(id, "foreign", "pwd\r")).rejects.toThrow("不属于");
    request.mockImplementation(async method => { if (method === "selfme.terminal.input") throw new Error("智能体正在工作"); return {}; });
    await expect(client.terminalInput(id, "term", "pwd\r")).rejects.toThrow("正在工作");
    expect(request).not.toHaveBeenCalledWith("selfme.control.acquire", expect.anything());
    client.shutdown();
  });
  it("publishes separate busy, human control and input permission from the server", async () => {
    const { client, request, updates } = fixture(); await client.open(id);
    const state = { agentBusy: false, humanControl: false, inputAllowed: true };
    request.mockResolvedValue(state);
    expect(await client.sceneAccess(id)).toEqual(state);
    expect(updates.at(-1)?.scene).toEqual(state); expect(updates.at(-1)?.humanControl).toBe(false);
    request.mockResolvedValue({ ...state, agentBusy: true, inputAllowed: false });
    expect((await client.sceneAccess(id)).inputAllowed).toBe(false);
    request.mockResolvedValue({}); await expect(client.sceneAccess(id)).rejects.toThrow("尚未就绪");
    client.shutdown();
  });
  it("releases server custody if a desktop grant fails", async () => {
    const { client, request } = fixture();
    request.mockImplementation(async method => {
      if (method === "selfme.control.acquire") return { id: "failed-lease" };
      if (method === "sessions.list") return { sessions: [] };
      if (method === "selfme.scene.observe") throw new Error("grant failed"); return {};
    });
    await expect(client.desktop(id, true)).rejects.toThrow("grant failed");
    expect(request).toHaveBeenCalledWith("selfme.control.release", { id: "failed-lease" }); client.shutdown();
  });
  it("projects partial native command output before the tool completes", async () => {
    const { client, updates, event } = fixture(); await client.open(id);
    event({ event: "session.tool", payload: { sessionKey: id, data: { phase: "start", name: "exec", toolCallId: "exec-live", args: { command: "printf progress" } } } });
    event({ event: "session.tool", payload: { sessionKey: id, data: { phase: "update", name: "exec", toolCallId: "exec-live", partialResult: { content: [{ text: "progress" }] } } } });
    expect(updates.at(-1)?.items.find(item => item.id === "live:exec-live")?.tool).toMatchObject({ status: "running", output: "progress" });
    client.shutdown();
  });
  it("does not keep a native PTY when attaching fails", async () => {
    const { client, request } = fixture();
    request.mockImplementation(async method => {
      if (method === "selfme.scene.prepare") return { root: "/home/node/.openclaw/workspace/selfme/c0ec83da-66be-4f17-a2c2-01dc02c89f00" };
      if (method === "terminal.open") return { sessionId: "failed-term", cwd: "/home/node/.openclaw/workspace/selfme/c0ec83da-66be-4f17-a2c2-01dc02c89f00" };
      if (method === "terminal.attach") throw new Error("attach failed"); return {};
    });
    await expect(client.terminal(id)).rejects.toThrow("attach failed");
    expect(request).toHaveBeenCalledWith("terminal.close", { sessionId: "failed-term" }); client.shutdown();
  });
});
