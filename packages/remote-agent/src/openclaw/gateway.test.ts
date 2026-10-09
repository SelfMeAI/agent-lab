import { createHash, createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenClawIdentity, GatewayRequestError, openClawConnect, openClawRpc } from "./gateway";

afterEach(() => vi.unstubAllGlobals());
describe("native OpenClaw protocol v4", () => {
  it("signs the native v3 challenge with stable device identity and exact scopes", () => {
    const identity = createOpenClawIdentity();
    expect(identity.deviceId).toBe(createHash("sha256").update(Buffer.from(identity.publicKey, "base64url")).digest("hex"));
    const connect = openClawConnect(identity, "fixture-token", "server-challenge", 12345);
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(identity.publicKey, "base64url")]), type: "spki", format: "der" });
    const payload = ["v3", identity.deviceId, "gateway-client", "backend", "operator", connect.scopes.join(","), "12345", "fixture-token", "server-challenge", process.platform, ""].join("|");
    expect(verify(null, Buffer.from(payload), publicKey, Buffer.from(connect.device.signature, "base64url"))).toBe(true);
    expect(connect.minProtocol).toBe(4); expect(connect.maxProtocol).toBe(4);
    expect(connect).not.toHaveProperty("dangerouslyDisableDeviceAuth");
  });
  it("retains exact native pairing error details and closes failed connections", async () => {
    class Socket extends EventTarget {
      static last: Socket; closed = false;
      constructor() { super(); Socket.last = this; queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce", ts: 12345 } }) }))); }
      send(raw: string) { const packet = JSON.parse(raw); queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "res", id: packet.id, ok: false, error: { code: "NOT_PAIRED", message: "pairing required", details: { requestId: "exact-request" } } }) }))); }
      close() { this.closed = true; }
    }
    vi.stubGlobal("WebSocket", Socket);
    try { await openClawRpc("http://127.0.0.1:1234", "fixture", createOpenClawIdentity(), "health"); throw new Error("expected rejection"); }
    catch (error) { expect(error).toBeInstanceOf(GatewayRequestError); expect((error as GatewayRequestError).details?.requestId).toBe("exact-request"); }
    expect(Socket.last.closed).toBe(true);
  });
});
