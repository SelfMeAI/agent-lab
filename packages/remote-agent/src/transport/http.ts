import type { RemoteAgentId, RemoteFilePage, RemoteUploadedFile } from "../../../contracts/src/remote-agent";
import { remoteEndpoint } from "./endpoint";
export class RemoteHttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export function remoteTaskId(id: string): string {
  const match = /(?:^|:selfme:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(id);
  if (!match) throw new Error("任务标识无效"); return match[1];
}
export function remoteFilePath(path: string): string {
  if (typeof path !== "string" || path.includes("\0") || path.includes("\\") || path.startsWith("/") || path.split("/").some(part => part === ".." || part.startsWith(".selfme-"))) throw new Error("文件路径无效");
  return path;
}
export class RemoteHttp {
  private cached?: string;
  constructor(readonly engine: RemoteAgentId, private readonly endpoint: () => Promise<string>, private readonly token: () => Promise<string>) {}
  reset(): void { this.cached = undefined; }
  async base(): Promise<string> { return this.cached ??= remoteEndpoint(await this.endpoint(), true); }
  async request(path: string, options: RequestInit = {}, timeout = 30_000): Promise<Response> {
    const response = await fetch(await this.base() + path, { ...options, redirect: "error", headers: { ...(this.engine === "openhands" ? { "X-Session-API-Key": await this.token() } : { Authorization: `Bearer ${await this.token()}` }), ...options.headers }, signal: options.signal ?? AbortSignal.timeout(timeout) });
    if (!response.ok) {
      let detail = ""; try { const body = await response.json(); detail = typeof body.detail === "string" ? body.detail : body.error ?? ""; } catch { /* no text echo of gateways/credentials */ }
      throw new RemoteHttpError(detail || `远端请求失败（${response.status}）`, response.status);
    }
    return response;
  }
  async json<T>(path: string, method = "GET", body?: unknown, headers?: Record<string, string>): Promise<T> {
    return (await this.request(path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })).json() as Promise<T>;
  }
  private fileUrl(id: string, path: string, list = false): string {
    const query = new URLSearchParams({ task: remoteTaskId(id), path: remoteFilePath(path), ...(list ? { op: "list" } : {}) });
    return `${this.engine === "openhands" ? "/api/selfme" : "/selfme-lab"}/files?${query}`;
  }
  listFiles(id: string, path = ""): Promise<RemoteFilePage> { return this.json(this.fileUrl(id, path, true)); }
  async upload(id: string, path: string, bytes: Uint8Array): Promise<RemoteUploadedFile> {
    return (await this.request(this.fileUrl(id, path), { method: "PUT", body: bytes as unknown as BodyInit }, 120_000)).json() as Promise<RemoteUploadedFile>;
  }
  async download(id: string, path: string): Promise<Response> { return this.request(this.fileUrl(id, path), {}, 120_000); }
}
