import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueNative } from "../../../../services/remote-agent/openclaw/plugin/queue-native";
import { OpenClawConnection } from "./connection";
import { createOpenClawIdentity } from "./gateway";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const id = "53b1dfe1-b090-4a2d-b680-8eb4f0172812";
function fixture(page: unknown, sessionKey = "agent:main:agent-lab:task") {
  const native = new QueueNative(".work/remote-agent/native-queue-test", () => {}, async () => {});
  const request = vi.fn(async (method: string) => method === "sessions.list" ? { sessions: [{ key: sessionKey }] } : page);
  vi.spyOn(native as unknown as { gateway(): Promise<unknown> }, "gateway").mockResolvedValue({ request });
  return { native, request };
}
describe("OpenClaw native input custody", () => {
  it("keeps queued native receipts and delivery bound to the original session after renaming", async () => {
    const { native, request } = fixture({ inputReceipts: [{ runId: id, state: "consumed" }] }, "agent:main:selfme:task");
    expect(await native.receipt("task", id)).toBe("consumed");
    await native.send("task", "new instruction", id, true, () => true);
    expect(request).toHaveBeenCalledWith("chat.send", { sessionKey: "agent:main:selfme:task", message: "new instruction", queueMode: "steer", idempotencyKey: id });
    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(1);
  });
  it("never creates a substitute native session when the original is missing", async () => {
    const { native, request } = fixture({});
    request.mockImplementation(async () => ({ sessions: [] }));
    await expect(native.receipt("missing", id)).rejects.toThrow("未创建替代会话");
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });
  it("recognizes direct-turn durable correlation without pretending it has a pending-input receipt", async () => {
    const { native } = fixture({ inputReceipts: [], messages: [{ role: "user", content: "text", __openclaw: { idempotencyKey: id + ":user" } }] });
    expect(await native.receipt("task", id)).toBe("consumed");
  });
  it("does not match uncorrelated text or another run", async () => {
    const { native } = fixture({ messages: [{ role: "user", content: id, __openclaw: { idempotencyKey: "different:user" } }] });
    expect(await native.receipt("task", id)).toBe("absent");
  });
  it.each(["pending", "consumed"] as const)("reads a native %s receipt", async state => {
    const { native } = fixture({ inputReceipts: [{ runId: id, state }] }); expect(await native.receipt("task", id)).toBe(state);
  });
  it("retains native cancelled inputs rather than marking them sent", async () => {
    const { native } = fixture({ inputReceipts: [{ runId: id, state: "pending", cancelled: true }] }); expect(await native.receipt("task", id)).toBe("interrupted");
  });
  it("permits native approval registration without admin/pairing or declaring an approval receiver", async () => {
    let handshake: Record<string, unknown> = {};
    class Socket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.frame({ type: "event", event: "connect.challenge", payload: { nonce: "fixture", ts: 12345 } })); }
      frame(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
      send(raw: string) { const packet = JSON.parse(raw); handshake = packet.params; queueMicrotask(() => this.frame({ type: "res", id: packet.id, ok: true, payload: {} })); }
      close() { this.dispatchEvent(new Event("close")); }
    }
    vi.stubGlobal("WebSocket", Socket);
    const connection = new OpenClawConnection("http://127.0.0.1:1234", "fixture", createOpenClawIdentity(), () => {}, () => {}, { scopes: ["operator.read", "operator.write", "operator.approvals"], approvals: false, displayName: "Queue service" });
    try { await connection.connect(); expect(handshake.scopes).toEqual(["operator.read", "operator.write", "operator.approvals"]); expect(handshake.caps).not.toContain("approvals"); }
    finally { connection.close(); }
  });
});
