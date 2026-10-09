import { afterEach, describe, expect, it, vi } from "vitest";
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
    const first = request.mock.calls.find(([name]) => name === "chat.send")?.[1];
    expect(first).toMatchObject({ sessionKey: id, message: "start" });
    expect(first).not.toHaveProperty("queueMode"); expect(first).not.toHaveProperty("timeoutMs");
    await client.send(id, "supplement");
    expect(request).toHaveBeenCalledWith("chat.send", expect.objectContaining({ queueMode: "steer", message: "supplement" }));
    event({ event: "chat", payload: { sessionKey: id, state: "aborted" } });
    await client.send(id, "retry");
    const retry = request.mock.calls.filter(([name]) => name === "chat.send").at(-1)?.[1];
    expect(retry).not.toHaveProperty("queueMode"); client.shutdown();
  });
  it("projects native questions including Other and cancels without fabricating answers", async () => {
    const { client, request, event, updates } = fixture(); await client.open(id);
    event({ event: "question.requested", payload: { sessionKey: id, id: "question", status: "pending", questions: [{ questionId: "q", header: "方案", question: "选择方案", options: [{ label: "A", description: "描述" }], multiSelect: false, isOther: true }] } });
    expect(updates.at(-1)?.items.find(item => item.question)?.question?.questions[0]).toMatchObject({ id: "q", other: true, options: [{ label: "A", description: "描述" }] });
    await client.answer(id, "question", null); expect(request).toHaveBeenCalledWith("question.resolve", { id: "question", cancel: true }); client.shutdown();
  });
  it("binds PTY actions to the task and deduplicates the attached buffer's sequence", async () => {
    const { client, request, event, terminalEvents } = fixture();
    request.mockImplementation(async method => method === "terminal.open" ? { sessionId: "term", cwd: "/remote/workspace", confined: false } : method === "terminal.attach" ? { buffer: "initial", seq: 7 } : {});
    expect(await client.terminal(id)).toMatchObject({ id: "term", buffer: "initial" });
    event({ event: "terminal.data", payload: { sessionId: "term", seq: 7, data: "initial" } });
    event({ event: "terminal.data", payload: { sessionId: "term", seq: 8, data: "next" } });
    expect(terminalEvents).toHaveLength(1); expect(terminalEvents[0].data).toBe("next");
    await expect(client.terminalInput(id.replace("c0ec", "a0ec"), "term", "pwd")).rejects.toThrow("不属于"); client.shutdown();
  });
});
