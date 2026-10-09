import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { remoteEndpoint } from "../transport/endpoint";

export interface OpenClawIdentity { deviceId: string; publicKey: string; privateKeyPem: string }
export function createOpenClawIdentity(): OpenClawIdentity {
  const pair = generateKeyPairSync("ed25519");
  const raw = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { deviceId: createHash("sha256").update(raw).digest("hex"), publicKey: raw.toString("base64url"),
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}
export function validOpenClawIdentity(value: OpenClawIdentity): boolean {
  try {
    const publicKey = createPublicKey(value.privateKeyPem).export({ type: "spki", format: "der" }).subarray(-32);
    return value.publicKey === publicKey.toString("base64url") && value.deviceId === createHash("sha256").update(publicKey).digest("hex");
  } catch { return false; }
}

/** Pinned OpenClaw protocol v4 / signed v3 device envelope. No browser/CDP access. */
export function openClawConnect(identity: OpenClawIdentity, token: string, nonce: string, signedAt: number) {
  const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
  const platform = process.platform;
  const payload = ["v3", identity.deviceId, "gateway-client", "backend", "operator", scopes.join(","), String(signedAt), token, nonce, platform, ""].join("|");
  return { minProtocol: 4, maxProtocol: 4,
    client: { id: "gateway-client", displayName: "SelfMe Lab", version: "0.1.0", platform, mode: "backend" },
    role: "operator", scopes, caps: [], auth: { token },
    device: { id: identity.deviceId, publicKey: identity.publicKey, nonce, signedAt,
      signature: sign(null, Buffer.from(payload), identity.privateKeyPem).toString("base64url") } };
}

export class GatewayRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly details?: Record<string, unknown>) { super(message); }
}
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Native RPC transport; a fresh authenticated socket per operation, bounded and always closed. */
export async function openClawRpc<T>(endpoint: string, token: string, identity: OpenClawIdentity, method: string, params: unknown = {}, timeout = 12_000): Promise<T> {
  const url = new URL(remoteEndpoint(endpoint, true));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  const pending = new Map<string, Pending>();
  let rejectConnect: (error: Error) => void = () => {};
  let resolveConnect: () => void = () => {};
  const connected = new Promise<void>((resolve, reject) => { resolveConnect = resolve; rejectConnect = reject; });
  const connectTimer = setTimeout(() => rejectConnect(new Error("OpenClaw 连接超时")), timeout);
  let challengeSeen = false;
  function request<R>(name: string, value: unknown): Promise<R> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`OpenClaw 请求超时（${name}）`)); }, timeout);
      pending.set(id, { resolve: (result) => resolve(result as R), reject, timer });
      try { socket.send(JSON.stringify({ type: "req", id, method: name, params: value })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  socket.addEventListener("message", event => {
    try {
      const packet = JSON.parse(String(event.data));
      if (packet.type === "event" && packet.event === "connect.challenge" && !challengeSeen) {
        challengeSeen = true;
        const { nonce, ts } = packet.payload ?? {};
        if (typeof nonce !== "string" || !nonce || !Number.isSafeInteger(ts)) { rejectConnect(new Error("OpenClaw 认证挑战无效")); return; }
        void request("connect", openClawConnect(identity, token, nonce, ts)).then(resolveConnect, rejectConnect);
      } else if (packet.type === "res" && typeof packet.id === "string") {
        const entry = pending.get(packet.id);
        if (!entry) return;
        clearTimeout(entry.timer); pending.delete(packet.id);
        if (packet.ok) entry.resolve(packet.payload);
        else entry.reject(new GatewayRequestError(packet.error?.message ?? "OpenClaw 请求失败", packet.error?.code, packet.error?.details));
      }
    } catch { rejectConnect(new Error("OpenClaw 返回了无效协议数据")); }
  });
  socket.addEventListener("error", () => rejectConnect(new Error("无法连接 OpenClaw 服务")));
  socket.addEventListener("close", () => {
    const error = new Error("OpenClaw 连接已断开");
    rejectConnect(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  });
  try { await connected; clearTimeout(connectTimer); return await request<T>(method, params); }
  finally {
    clearTimeout(connectTimer);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("OpenClaw 请求已关闭")); }
    pending.clear(); socket.close();
  }
}
