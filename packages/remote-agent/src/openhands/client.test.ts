import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteTaskSnapshot } from "../../../contracts/src/remote-agent";
import { handsTask, OpenHandsTasks } from "./client";
import { RemoteHttp, RemoteHttpError } from "../transport/http";

const id = "c0ec83da-66be-4f17-a2c2-01dc02c89f00";
class NativeSocket extends EventTarget {
  static current: NativeSocket;
  static through = -1;
  closed = false;
  constructor(readonly url: string) { super(); NativeSocket.current = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(value: string): void { if (JSON.parse(value).type === "auth") this.frame({ type: "sync", through_seq: NativeSocket.through }); }
  frame(value: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  close(): void { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event("close")); } }
}
afterEach(() => { NativeSocket.through = -1; Reflect.deleteProperty(NativeSocket, "current"); vi.unstubAllGlobals(); });
function fixture() {
  vi.stubGlobal("WebSocket", NativeSocket);
  const http = new RemoteHttp("openhands", async () => "http://127.0.0.1:1234", async () => "private-token");
  const json = vi.spyOn(http, "json").mockImplementation(async (path: string) => {
    if (path.includes("events/search")) return { items: [{ id: "canonical-user", kind: "MessageEvent", source: "user", llm_message: { role: "user", content: [{ text: "Hello" }] } }] };
    return { id, title: "新任务", execution_status: "idle" };
  });
  const updates: RemoteTaskSnapshot[] = [];
  const client = new OpenHandsTasks(http, async () => "private-token", update => updates.push(update));
  return { client, json, updates };
}
describe("OpenHands ordered native task stream", () => {
  it("does not invent fresh activity when native metadata omits a timestamp", () => {
    const row = { id, title: "新任务", created_at: "2026-10-12T12:00:00Z" };
    expect(handsTask(row).updatedAt).toBe("2026-10-12T12:00:00.000Z");
    expect(handsTask(row)).toEqual(handsTask(row));
    expect(handsTask({ id }).updatedAt).toBe("1970-01-01T00:00:00.000Z");
  });
  it("history replay cannot regress activity and newer assistant/tool work advances it", async () => {
    const { client, json, updates } = fixture();
    json.mockResolvedValue({ id, title: "Task", execution_status: "finished", updated_at: "2026-10-12T15:10:00Z" });
    await client.open(id);
    NativeSocket.current.frame({ type: "durable", seq: 0, event: { id: "old", kind: "MessageEvent", source: "user", timestamp: "2026-10-12T14:50:00", llm_message: { content: [{ text: "old" }] } } });
    expect(updates.at(-1)?.task.updatedAt).toBe("2026-10-12T15:10:00.000Z");
    NativeSocket.current.frame({ type: "durable", seq: 1, event: { id: "assistant", kind: "MessageEvent", source: "agent", timestamp: "2026-10-12T15:11:00", llm_message: { content: [{ text: "done" }] } } });
    expect(updates.at(-1)?.task.updatedAt).toBe("2026-10-12T15:11:00.000Z");
    NativeSocket.current.frame({ type: "durable", seq: 2, event: { id: "state", kind: "ConversationStateUpdateEvent", timestamp: "2026-10-12T15:12:00", key: "execution_status", value: "finished" } });
    expect(updates.at(-1)?.task.updatedAt).toBe("2026-10-12T15:11:00.000Z");
    client.shutdown();
  });
  it("creates a visible browser with automatic confirmed vision instead of a stale override", async () => {
    const { client, json } = fixture();
    json.mockImplementation(async (path: string) => {
      if (path === "/api/selfme/workspace") return { root: "/workspace/selfme/fixture" };
      if (path === "/api/settings") return { llm_api_key_is_set: true, agent_settings: { llm: { model: "openai/deepseek-flash", base_url: "https://api.deepseek.com", api_key: "encrypted-fixture", capability_overrides: { supports_vision: false } } } };
      return { id, title: "新任务", execution_status: "idle" };
    });
    await client.create();
    expect(json).toHaveBeenCalledWith("/api/conversations", "POST", expect.objectContaining({
      secrets_encrypted: true,
      agent_settings: expect.objectContaining({
        llm: expect.objectContaining({ model_canonical_name: "deepseek/deepseek-v4.1-flash", stream: true, capability_overrides: { supports_vision: true } }),
        tools: expect.arrayContaining([expect.objectContaining({ name: "browser_tool_set", params: expect.objectContaining({ headless: false }) })]),
      }),
    })); client.shutdown();
  });
  it("waits for the advertised native replay watermark before returning history", async () => {
    const { client } = fixture(); NativeSocket.through = 1;
    let resolved = false; const opening = client.open(id).then(snapshot => { resolved = true; return snapshot; });
    await vi.waitFor(() => expect(String(NativeSocket.current.url)).toContain(id));
    await Promise.resolve(); expect(resolved).toBe(false);
    NativeSocket.current.frame({ type: "durable", seq: 0, event: { id: "user", kind: "MessageEvent", source: "user", llm_message: { content: [{ text: "persisted" }] } } });
    await Promise.resolve(); expect(resolved).toBe(false);
    NativeSocket.current.frame({ type: "durable", seq: 1, event: { id: "state", kind: "ConversationStateUpdateEvent", key: "execution_status", value: "finished" } });
    const snapshot = await opening; expect(snapshot.connection).toBe("connected"); expect(snapshot.items[0].text).toBe("persisted"); expect(snapshot.task.status).toBe("completed"); client.shutdown();
  });
  it("authenticates in a first frame rather than leaking the token in a URL", async () => {
    const { client } = fixture(); await client.open(id);
    expect(String(NativeSocket.current.url)).toContain("after_seq=-1"); expect(String(NativeSocket.current.url)).not.toContain("private-token"); client.shutdown();
  });
  it("deduplicates durable sequence replay and projects native execution state", async () => {
    const { client, updates } = fixture(); await client.open(id);
    const frame = { type: "durable", seq: 0, event: { id: "user", kind: "MessageEvent", source: "user", llm_message: { content: [{ text: "Hello" }] } } };
    NativeSocket.current.frame(frame); NativeSocket.current.frame(frame);
    NativeSocket.current.frame({ type: "durable", seq: 1, event: { id: "state", kind: "ConversationStateUpdateEvent", key: "execution_status", value: "finished" } });
    expect(updates.at(-1)?.items).toHaveLength(1); expect(updates.at(-1)?.task.status).toBe("completed"); client.shutdown();
  });
  it("handles streaming retries, duplicate deltas and canonical replacement", async () => {
    const { client, updates } = fixture(); await client.open(id); const ws = NativeSocket.current;
    ws.frame({ type: "item_started", item_id: "message", attempt: 1 });
    ws.frame({ type: "delta", item_id: "message", attempt: 1, order: 0, content: "a" });
    ws.frame({ type: "delta", item_id: "message", attempt: 1, order: 0, content: "duplicate" });
    expect(updates.at(-1)?.items[0].text).toBe("a");
    ws.frame({ type: "item_started", item_id: "message", attempt: 2 });
    ws.frame({ type: "delta", item_id: "message", attempt: 1, order: 1, content: "stale" });
    ws.frame({ type: "delta", item_id: "message", attempt: 2, order: 0, kind: "reasoning", content: "thought" });
    ws.frame({ type: "delta", item_id: "message", attempt: 2, order: 1, content: "fresh" });
    expect(updates.at(-1)?.items[0]).toMatchObject({ text: "fresh", reasoning: "thought", streaming: true });
    ws.frame({ type: "durable", seq: 0, event: { id: "message", kind: "MessageEvent", llm_message: { content: [{ text: "complete" }] } } });
    expect(updates.at(-1)?.items).toHaveLength(1); expect(updates.at(-1)?.items[0]).toMatchObject({ text: "complete", streaming: false }); client.shutdown();
  });
  it("does not display a misleading lossy partial answer", async () => {
    const { client, updates } = fixture(); await client.open(id); const ws = NativeSocket.current;
    ws.frame({ type: "item_started", item_id: "message", attempt: 1 });
    ws.frame({ type: "delta", item_id: "message", attempt: 1, order: 0, content: "a" });
    ws.frame({ type: "delta", item_id: "message", attempt: 1, order: 3, content: "d" });
    expect(updates.at(-1)?.items).toHaveLength(0);
    ws.frame({ type: "durable", seq: 0, event: { id: "message", kind: "MessageEvent", llm_message: { content: [{ text: "abcd" }] } } });
    expect(updates.at(-1)?.items[0].text).toBe("abcd"); client.shutdown();
  });
  it("fetches the accepted canonical user event without the broken short-name kind filter", async () => {
    const { client, json, updates } = fixture(); await client.open(id); await client.send(id, "Hello");
    expect(updates.some(update => update.items.some(item => item.id === "canonical-user" && item.role === "user"))).toBe(true);
    expect(json.mock.calls.find(([path]) => path.includes("events/search"))?.[0]).not.toContain("kind="); client.shutdown();
  });
  it("does not re-send an accepted message when native run admission returns 429", async () => {
    const { client, json, updates } = fixture(); await client.open(id);
    json.mockRejectedValueOnce(new RemoteHttpError("busy", 429)); await client.send(id, "Hello");
    expect(updates.at(-1)?.task.status).toBe("paused"); expect(updates.at(-1)?.error).toContain("消息已保存");
    expect(updates.at(-1)?.items.some(item => item.id === "canonical-user")).toBe(true);
    expect(json.mock.calls.filter(([path, method]) => path.endsWith("/events") && method === "POST")).toHaveLength(1); client.shutdown();
  });
  it("replays execution failure with its reason and accepts a continuation in the same conversation", async () => {
    const { client, json, updates } = fixture(); NativeSocket.through = 0;
    const opening = client.open(id);
    await vi.waitFor(() => { expect(String(NativeSocket.current.url)).toContain(id); expect(NativeSocket.current.closed).toBe(false); });
    const fatal = { type: "durable", seq: 0, event: { id: "native-failure", kind: "ConversationErrorEvent", detail: "API Error: 524", timestamp: "2026-10-10T04:17:39Z" } };
    NativeSocket.current.frame(fatal);
    const snapshot = await opening;
    expect(snapshot).toMatchObject({ connection: "connected", task: { status: "error" }, failure: { message: "API Error: 524" } });
    expect(snapshot.error).toBeUndefined(); expect(snapshot.items[0].failure?.message).toBe("API Error: 524");
    client.close(id); const reopened = client.open(id);
    await vi.waitFor(() => expect(NativeSocket.current.closed).toBe(false)); NativeSocket.current.frame(fatal);
    expect((await reopened).failure).toEqual(snapshot.failure);
    await client.send(id, "Continue after checking existing files");
    expect(json).toHaveBeenCalledWith(`/api/conversations/${id}/events`, "POST", expect.objectContaining({ run: true }));
    expect(updates.at(-1)?.task.status).toBe("running"); expect(updates.at(-1)?.failure).toBeUndefined();
    expect(updates.at(-1)?.items.some(item => item.failure)).toBe(true); client.shutdown();
  });
  it("native always permission is scoped to this conversation", async () => {
    const { client, json, updates } = fixture(); await client.open(id);
    NativeSocket.current.frame({ type: "transient", event: { id: "approval-state", kind: "ConversationStateUpdateEvent", key: "full_state", value: { execution_status: "awaiting_user_confirmation", pending_actions: [{ id: "native-action", tool_name: "terminal" }] } } });
    const requestId = updates.at(-1)!.items.find(item => item.approval)!.approval!.id;
    await client.approve(id, requestId, "always");
    expect(json).toHaveBeenCalledWith(`/api/conversations/${id}/confirmation_policy`, "POST", { policy: { kind: "NeverConfirm" } });
    expect(json).toHaveBeenCalledWith(`/api/conversations/${id}/events/respond_to_confirmation`, "POST", expect.objectContaining({ accept: true })); client.shutdown();
  });
  it("does not approve a stale action after the native pending operation changes", async () => {
    const { client, json } = fixture(); await client.open(id);
    const pending = (action: string) => NativeSocket.current.frame({ type: "transient", event: { id: "state", kind: "ConversationStateUpdateEvent", key: "full_state", value: { execution_status: "awaiting_user_confirmation", pending_actions: [{ id: action }] } } });
    pending("old-action"); pending("new-action");
    await expect(client.approve(id, "confirmation:old-action", "always")).rejects.toThrow("审批已结束或已改变");
    expect(json.mock.calls.some(([path]) => path.endsWith("confirmation_policy") || path.endsWith("respond_to_confirmation"))).toBe(false);
    await client.approve(id, "confirmation:new-action", "once"); client.shutdown();
  });
  it("closing an observer neither interrupts nor deletes the server task", async () => {
    const { client, json } = fixture(); await client.open(id); client.close(id);
    expect(NativeSocket.current.closed).toBe(true); expect(json.mock.calls.some(([path]) => path.endsWith("/interrupt"))).toBe(false); client.shutdown();
  });
  it("a pending open cannot resurrect a closed or reset observer", async () => {
    const { client, json, updates } = fixture();
    let finish!: (value: unknown) => void;
    json.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const opening = client.open(id); client.close(id); finish({ id, title: "late" });
    await expect(opening).rejects.toThrow("视图已关闭"); expect(updates).toHaveLength(0); client.shutdown();
  });
});
