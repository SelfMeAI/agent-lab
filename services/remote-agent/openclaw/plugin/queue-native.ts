import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenClawConnection, type GatewayEvent } from "./native/openclaw/connection";
import { createOpenClawIdentity, validOpenClawIdentity, GatewayRequestError, type OpenClawIdentity } from "./native/openclaw/gateway";
import type { InputDriver, NativeState } from "./input-queue";
import { openClawTaskPrefixes } from "./identity";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
/** Container-local service identity. Native tools may register approvals;
 * this transport never receives approval cards or submits an approval verdict. */
export class QueueNative implements InputDriver {
  private connection?: OpenClawConnection;
  private connecting?: Promise<OpenClawConnection>;
  private sessionKeys = new Map<string, string>();
  constructor(private readonly directory: string, private readonly onEvent: (event: GatewayEvent) => void, private readonly prepare: (task: string) => Promise<void>) {}
  private async gateway(): Promise<OpenClawConnection> {
    if (this.connection) return this.connection;
    if (!this.connecting) this.connecting = (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = join(this.directory, "service-device.json"); let identity: OpenClawIdentity;
      try { identity = JSON.parse(await readFile(file, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        identity = createOpenClawIdentity(); await writeFile(file, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
      }
      if (!validOpenClawIdentity(identity)) throw new Error("待发服务身份无效，消息已保留");
      const token = process.env.OPENCLAW_GATEWAY_TOKEN;
      if (!token) throw new Error("待发服务认证未就绪，消息已保留");
      const create = () => new OpenClawConnection("http://127.0.0.1:18789", token, identity, this.onEvent, () => { this.connection = undefined; }, { scopes: ["operator.read", "operator.write", "operator.approvals"], displayName: "Agent Lab Queue Service", approvals: false });
      let connection = create();
      try { await connection.connect(); }
      catch (error) {
        connection.close();
        // Approve only our freshly created identity through the native local
        // administration CLI. Never approve --latest or an unrelated device.
        if (!(error instanceof GatewayRequestError) || error.code !== "NOT_PAIRED" || error.details?.deviceId !== identity.deviceId || typeof error.details.requestId !== "string" || !/^[0-9a-f-]{36}$/.test(error.details.requestId)) throw error;
        await promisify(execFile)("node", ["/app/openclaw.mjs", "devices", "approve", error.details.requestId, "--json"], { timeout: 30_000, maxBuffer: 512 * 1024 });
        connection = create(); await connection.connect();
      }
      this.connection = connection; return connection;
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async history(task: string, id?: string): Promise<Record<string, unknown>> {
    return (await this.gateway()).request("chat.history", { sessionKey: await this.sessionKey(task), limit: id ? 100 : 1, maxBytes: 400_000, ...(id ? { inputRunIds: [id] } : {}) });
  }
  private async sessionKey(task: string): Promise<string> {
    const cached = this.sessionKeys.get(task); if (cached) return cached;
    const connection = await this.gateway(); let offset = 0;
    for (;;) {
      const page = record(await connection.request("sessions.list", { limit: 100, offset, sortBy: "updatedAt" }));
      const rows = Array.isArray(page.sessions) ? page.sessions.map(record) : [];
      const row = rows.find(row => openClawTaskPrefixes.some(prefix => row.key === prefix + task));
      if (row) { const key = String(row.key); this.sessionKeys.set(task, key); return key; }
      if (rows.length < 100) throw new Error("任务不存在或已删除，未创建替代会话");
      offset += rows.length;
    }
  }
  async state(task: string): Promise<NativeState> {
    const page = await this.history(task);
    if (page.inFlightRun) return "running";
    const status = String(record(page.sessionInfo).status ?? "idle").toLowerCase();
    if (/error|fail|stuck/.test(status)) return "error";
    if (/paused|stopped|aborted/.test(status)) return "paused";
    if (/waiting|approval/.test(status)) return "waiting";
    if (/running|active/.test(status)) return "running";
    return /complete|finish|done/.test(status) ? "completed" : "idle";
  }
  async receipt(task: string, id: string): Promise<"consumed" | "pending" | "interrupted" | "absent"> {
    const page = await this.history(task, id);
    const receipts = Array.isArray(page.inputReceipts) ? page.inputReceipts.map(record) : [];
    const receipt = receipts.find(row => row.runId === id);
    if (receipt?.state === "consumed") return "consumed";
    // Ordinary turns are recorded directly, without a pending-input row. Match
    // the native persisted idempotency correlation, never message text or time.
    for (const value of Array.isArray(page.messages) ? page.messages : []) {
      const row = record(value), message = row.message ? record(row.message) : row, meta = record(message.__openclaw);
      if (message.role === "user" && (message.idempotencyKey === id + ":user" || meta.idempotencyKey === id + ":user")) return "consumed";
    }
    const pending = record(page.pendingInputs);
    const input = (Array.isArray(pending.items) ? pending.items.map(record) : []).find(row => row.runId === id);
    if (receipt?.cancelled || input?.state === "cancelled" || input?.state === "interrupted") return "interrupted";
    return receipt?.state === "pending" ? "pending" : "absent";
  }
  async send(task: string, body: string, id: string, steer: boolean, current: () => boolean): Promise<void> {
    const connection = await this.gateway();
    await this.prepare(task);
    if (!current()) throw new Error("投递已停止");
    await connection.request("chat.send", { sessionKey: await this.sessionKey(task), message: body, queueMode: steer ? "steer" : "collect", idempotencyKey: id });
  }
  async stop(task: string): Promise<void> { await (await this.gateway()).request("chat.abort", { sessionKey: await this.sessionKey(task) }); }
  close(): void { this.connection?.close(); this.connection = undefined; this.sessionKeys.clear(); }
}
