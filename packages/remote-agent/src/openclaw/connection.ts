import { randomUUID } from "node:crypto";
import { GatewayRequestError, openClawConnect, type OpenClawConnectOptions, type OpenClawIdentity } from "./gateway";
import { remoteEndpoint } from "../transport/endpoint";

export type GatewayEvent = { event: string; payload?: unknown; seq?: number };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Long-lived native connection: subscriptions, PTYs and observer grants belong to it. */
export class OpenClawConnection {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private ready = false;
  private disposed = false;
  private pending = new Map<string, Pending>();
  constructor(private readonly endpoint: string, private readonly token: string, private readonly identity: OpenClawIdentity,
    private readonly receive: (event: GatewayEvent) => void, private readonly disconnected: (error: Error) => void, private readonly options: OpenClawConnectOptions = {}) {}

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("连接已关闭"));
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const url = new URL(remoteEndpoint(this.endpoint, true)); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url); this.socket = socket;
    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false; let challenge = false;
      const timer = setTimeout(() => finish(new Error("OpenClaw 连接超时")), 15_000);
      const finish = (error?: Error): void => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) { reject(error); socket.close(); } else { this.ready = true; resolve(); }
      };
      socket.addEventListener("message", message => {
        try {
          const packet = JSON.parse(String(message.data));
          if (packet.type === "event") {
            if (packet.event === "connect.challenge" && !challenge) {
              challenge = true;
              const { nonce, ts } = packet.payload ?? {};
              if (typeof nonce !== "string" || !nonce || !Number.isSafeInteger(ts)) { finish(new Error("认证挑战无效")); return; }
              const params = openClawConnect(this.identity, this.token, nonce, ts, this.options);
              // This persistent connection renders native exec/plugin approval
              // cards. Scopes alone do not declare an approval delivery surface.
              // Short-lived status/config RPCs intentionally advertise no caps.
              params.caps = ["tool-events", "terminal-offset-seq", ...(this.options.approvals === false ? [] : ["approvals"])];
              void this.requestRaw("connect", params).then(() => finish(), error => finish(error));
            } else if (this.ready) this.receive(packet);
          } else if (packet.type === "res") {
            const pending = this.pending.get(packet.id); if (!pending) return;
            clearTimeout(pending.timer); this.pending.delete(packet.id);
            if (packet.ok) pending.resolve(packet.payload);
            else pending.reject(new GatewayRequestError(packet.error?.message ?? "请求失败", packet.error?.code, packet.error?.details));
          }
        } catch { const error = new Error("OpenClaw 返回了无效协议数据"); if (this.ready) socket.close(1002, "Invalid protocol data"); else finish(error); }
      });
      socket.addEventListener("error", () => finish(new Error("OpenClaw 连接失败")));
      socket.addEventListener("close", () => {
        const wasReady = this.ready; this.ready = false; this.connecting = undefined;
        const error = new Error("OpenClaw 连接已断开"); finish(error); this.rejectPending(error);
        if (!this.disposed && wasReady) this.disconnected(error);
      });
    });
    return this.connecting;
  }
  async request<T>(method: string, params: unknown = {}, timeout = 20_000): Promise<T> {
    await this.connect(); return this.requestRaw<T>(method, params, timeout);
  }
  private requestRaw<T>(method: string, params: unknown, timeout = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = randomUUID(); const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`OpenClaw 请求超时（${method}）`)); }, timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.socket!.send(JSON.stringify({ type: "req", id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private rejectPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  close(): void { this.disposed = true; this.ready = false; this.rejectPending(new Error("连接已关闭")); this.socket?.close(); }
}
