import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenClawConnection } from "./connection";
import { createOpenClawIdentity } from "./gateway";

afterEach(() => vi.unstubAllGlobals());
describe("native persistent approval surface", () => {
  it("declares rendered exec/plugin approvals without granting extra operator scopes", async () => {
    let handshake: Record<string, unknown> = {};
    class Socket extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.frame({ type: "event", event: "connect.challenge", payload: { nonce: "fixture", ts: 12345 } })); }
      frame(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
      send(raw: string) { const packet = JSON.parse(raw); handshake = packet.params; queueMicrotask(() => this.frame({ type: "res", id: packet.id, ok: true, payload: {} })); }
      close() { this.dispatchEvent(new Event("close")); }
    }
    vi.stubGlobal("WebSocket", Socket);
    const connection = new OpenClawConnection("http://127.0.0.1:1234", "fixture", createOpenClawIdentity(), () => {}, () => {});
    try {
      await connection.connect();
      expect(handshake.caps).toEqual(["tool-events", "terminal-offset-seq", "approvals"]);
      expect(handshake.scopes).toEqual(["operator.admin", "operator.approvals", "operator.pairing"]);
    } finally { connection.close(); }
  });
});
