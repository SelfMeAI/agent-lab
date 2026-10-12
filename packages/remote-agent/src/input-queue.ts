import type { RemoteInputQueue, RemoteSendOptions } from "../../contracts/src/remote-agent";

export function remoteSendOptions(value: unknown): RemoteSendOptions {
  const row = value as Partial<RemoteSendOptions> | null;
  if (!row || (row.mode !== "queue" && row.mode !== "steer") || typeof row.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.requestId)) throw new Error("发送方式或消息标识无效");
  return { mode: row.mode, requestId: row.requestId };
}
export function remoteInputQueue(value: unknown): RemoteInputQueue {
  const row = value as RemoteInputQueue | null;
  if (!row || !["queue", "steer"].includes(row.mode) || typeof row.paused !== "boolean" || !Number.isSafeInteger(row.revision) || row.revision < 0 || !Array.isArray(row.items) || row.items.length > 20 || row.items.some(item => !item || typeof item.id !== "string" || typeof item.text !== "string" || typeof item.at !== "string" || !["queued", "sending"].includes(item.state) || item.error !== undefined && typeof item.error !== "string" || !Array.isArray(item.files) || item.files.length > 10 || item.files.some(file => !file || typeof file.name !== "string" || typeof file.path !== "string"))) throw new Error("远端待发状态无效，请重新连接服务");
  return row;
}
export function mergeRemoteInputQueue(previous: RemoteInputQueue | undefined, next: RemoteInputQueue): RemoteInputQueue {
  return previous && previous.revision > next.revision ? previous : next;
}
