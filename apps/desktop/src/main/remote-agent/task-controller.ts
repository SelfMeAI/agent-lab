import { createServer, type Server } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { RemoteAgentId, RemoteDesktopGrant, RemoteFilePreview, RemoteTaskSnapshot, RemoteTaskUpdate, RemoteTerminalEvent, RemoteUploadedFile } from "../../../../../packages/contracts/src/remote-agent";
import { RemoteHttp, remoteFilePath, remoteTaskId } from "../../../../../packages/remote-agent/src/transport/http";
import { OpenHandsTasks } from "../../../../../packages/remote-agent/src/openhands/client";
import { OpenClawTasks } from "../../../../../packages/remote-agent/src/openclaw/client";
import type { RemoteCredentials } from "./credentials";

interface Connection { endpoint(): Promise<string>; credentials(): Promise<RemoteCredentials> }
interface FileDialogs { choose(): Promise<string[]>; save(name: string): Promise<string | null> }
const mimes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".woff": "font/woff", ".woff2": "font/woff2" };
export function remotePreviewKind(path: string): RemoteFilePreview["kind"] {
  const ext = extname(path).toLowerCase(); if ([".html", ".htm"].includes(ext)) return "html";
  if ([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  return [".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".toml", ".js", ".ts", ".tsx", ".jsx", ".py", ".sh", ".css", ".log", ".xml", ".sql", ".rs"].includes(ext) ? "text" : "binary";
}
type PreviewGrant = { engine: RemoteAgentId; task: string; expires: number };

export class RemoteTaskController {
  readonly hands: OpenHandsTasks;
  readonly claw: OpenClawTasks;
  private uploads = new Map<string, RemoteUploadedFile[]>();
  private grants = new Map<string, PreviewGrant>();
  private proxy?: Server;
  private proxyOrigin?: Promise<string>;
  constructor(connections: Record<RemoteAgentId, Connection>, private readonly dialogs: FileDialogs,
    emit: (event: RemoteTaskUpdate) => void, terminal: (event: RemoteTerminalEvent) => void) {
    const http = (engine: RemoteAgentId) => new RemoteHttp(engine, connections[engine].endpoint, async () => (await connections[engine].credentials()).sessionApiKey);
    const update = (engine: RemoteAgentId) => (snapshot: RemoteTaskSnapshot) => emit({ engine, taskId: snapshot.task.id, snapshot });
    this.hands = new OpenHandsTasks(http("openhands"), async () => (await connections.openhands.credentials()).sessionApiKey, update("openhands"));
    this.claw = new OpenClawTasks(http("openclaw"), connections.openclaw.credentials, update("openclaw"), terminal);
  }
  client(engine: RemoteAgentId): OpenHandsTasks | OpenClawTasks { return engine === "openhands" ? this.hands : this.claw; }
  private slot(engine: RemoteAgentId, id: string): string { remoteTaskId(id); return engine + ":" + id; }
  private revoke(engine: RemoteAgentId, id?: string): void { for (const [token, grant] of this.grants) if (grant.engine === engine && (!id || grant.task === id)) this.grants.delete(token); }
  async close(engine: RemoteAgentId, id: string): Promise<void> { this.revoke(engine, id); await this.client(engine).close(id); }
  async delete(engine: RemoteAgentId, id: string): Promise<void> { await this.client(engine).delete(id); this.uploads.delete(this.slot(engine, id)); this.revoke(engine, id); }
  earlier(engine: RemoteAgentId, id: string): Promise<RemoteTaskSnapshot> { if (engine === "openhands") return this.hands.open(id); return this.claw.earlier(id); }
  async send(engine: RemoteAgentId, id: string, prompt: string, files: RemoteUploadedFile[] = []): Promise<void> {
    if (typeof prompt !== "string" || prompt.length > 100_000 || !Array.isArray(files) || files.length > 10) throw new Error("消息或附件无效");
    const known = this.uploads.get(this.slot(engine, id)) ?? [];
    const verified = files.map(file => { const original = known.find(candidate => candidate.path === file.path && candidate.absolutePath === file.absolutePath); if (!original) throw new Error("附件不属于此任务，请重新上传"); return original; });
    await this.client(engine).send(id, prompt, verified);
  }
  async upload(engine: RemoteAgentId, id: string, remaining = 10): Promise<RemoteUploadedFile[]> {
    remoteTaskId(id); if (!Number.isInteger(remaining) || remaining < 1 || remaining > 10) throw new Error("每条消息最多附加 10 个文件");
    const choices = await this.dialogs.choose(); if (choices.length > remaining) throw new Error(`还可以附加 ${remaining} 个文件，请减少本次选择`);
    // Validate the whole selection before uploading anything.
    for (const path of choices) { const info = await stat(path); if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error(`${basename(path)} 超过单文件 20 MB 上限，或不是文件`); }
    const result: RemoteUploadedFile[] = [];
    for (const path of choices) {
      const name = basename(path).replace(/[\\/\0\r\n]/g, "_").slice(0, 160);
      const uploaded = await this.client(engine).http.upload(id, "uploads/" + randomUUID().slice(0, 8) + "-" + name, await readFile(path));
      result.push({ ...uploaded, name });
      // Preserve successful earlier uploads even if a later transfer fails.
      const slot = this.slot(engine, id); this.uploads.set(slot, [...(this.uploads.get(slot) ?? []), { ...uploaded, name }]);
    }
    return result;
  }
  async download(engine: RemoteAgentId, id: string, path: string): Promise<boolean> {
    remoteFilePath(path); const destination = await this.dialogs.save(basename(path)); if (!destination) return false;
    const response = await this.client(engine).http.download(id, path); const bytes = await boundedBytes(response, 64 * 1024 * 1024);
    // The native Save dialog authorizes this single destination, including replacement.
    const temporary = join(dirname(destination), ".selfme-download-" + randomUUID());
    try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, destination); }
    finally { await unlink(temporary).catch(() => {}); }
    return true;
  }
  async preview(engine: RemoteAgentId, id: string, path: string): Promise<RemoteFilePreview> {
    remoteTaskId(id); remoteFilePath(path); const kind = remotePreviewKind(path), mime = mimes[extname(path).toLowerCase()] ?? "application/octet-stream";
    const response = await this.client(engine).http.download(id, path); const size = Number(response.headers.get("content-length") ?? 0);
    if (kind === "text") {
      const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let count = 0; const cap = 1024 * 1024;
      try { while (count < cap) { const { done, value } = await reader.read(); if (done) break; const part = value.subarray(0, cap - count); count += part.length; chunks.push(part); } }
      finally { await reader.cancel(); }
      return { kind, text: Buffer.concat(chunks).toString("utf8"), size, mime, truncated: size > cap || count >= cap };
    }
    await response.body?.cancel();
    if (kind === "binary") return { kind, size, mime, truncated: false };
    for (const [token, grant] of this.grants) if (grant.expires < Date.now()) this.grants.delete(token);
    if (this.grants.size >= 40) this.grants.delete(this.grants.keys().next().value!);
    const token = randomBytes(24).toString("base64url"); this.grants.set(token, { engine, task: id, expires: Date.now() + 30 * 60_000 });
    return { kind, size, mime, truncated: false, url: `${await this.origin()}/${token}/${path.split("/").map(encodeURIComponent).join("/")}` };
  }
  private origin(): Promise<string> {
    if (this.proxyOrigin) return this.proxyOrigin;
    this.proxyOrigin = new Promise((resolve, reject) => {
      this.proxy = createServer((req, res) => {
        void (async () => {
          if (req.method !== "GET") { res.writeHead(405).end(); return; }
          const url = new URL(req.url ?? "/", "http://127.0.0.1"), parts = url.pathname.split("/");
          const grant = this.grants.get(parts[1]); if (!grant || grant.expires < Date.now()) { res.writeHead(410).end("预览已关闭，请重新打开"); return; }
          const path = parts.slice(2).map(decodeURIComponent).join("/"); remoteFilePath(path);
          const response = await this.client(grant.engine).http.download(grant.task, path);
          res.writeHead(200, { "Content-Type": mimes[extname(path).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Access-Control-Allow-Origin": "null",
            // PDF uses Chromium's sandboxed native PDF renderer. The URL is
            // task-scoped, always served as application/pdf with nosniff;
            // HTML keeps the opaque iframe and cannot load embedded plugins.
            "Content-Security-Policy": extname(path).toLowerCase() === ".pdf" ? "default-src 'none'; object-src 'self'; base-uri 'none'; form-action 'none'" : "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'" });
          const reader = response.body!.getReader(); let count = 0;
          res.on("close", () => { void reader.cancel().catch(() => {}); });
          try { for (;;) { const { done, value } = await reader.read(); if (done) break; count += value.length; if (count > 64 * 1024 * 1024) throw new Error("文件过大"); if (!res.write(value)) await new Promise<void>(resolve => { const finish = () => { res.off("drain", finish); res.off("close", finish); resolve(); }; res.once("drain", finish); res.once("close", finish); }); if (res.destroyed) break; } res.end(); }
          finally { await reader.cancel().catch(() => {}); }
        })().catch(() => { if (!res.headersSent) res.writeHead(404).end("文件暂不可用"); else res.destroy(); });
      });
      this.proxy.once("error", reject); this.proxy.listen(0, "127.0.0.1", () => { const address = this.proxy!.address(); if (!address || typeof address === "string") { reject(new Error("预览服务未启动")); return; } resolve(`http://127.0.0.1:${address.port}`); });
    });
    return this.proxyOrigin;
  }
  async desktop(engine: RemoteAgentId, id: string, control: boolean) {
    remoteTaskId(id); if (engine === "openclaw") return this.claw.desktop(id, control);
    if (control) throw new Error("OpenHands 浏览器仅支持观察，不提供桌面接管");
    const result = await this.hands.http.json<{ wsPath: string; expiresAt: number; control: boolean }>("/api/selfme/observer", "POST", { task: id });
    const base = new URL(await this.hands.http.base()); base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    return { url: new URL(result.wsPath, base).toString(), expiresAt: result.expiresAt, control: false };
  }
  async returnDesktop(engine: RemoteAgentId, id: string, followUp?: string): Promise<RemoteDesktopGrant> {
    if (engine !== "openclaw") throw new Error("此引擎不支持接管"); await this.claw.release();
    const grant = await this.claw.desktop(id, false);
    if (followUp?.trim()) {
      try { await this.claw.send(id, `人工接管已结束。先重新观察远端现场并核对文件，不要使用接管前的画面或重复已完成操作。\n${followUp}`); }
      catch (error) { return { ...grant, warning: `已交还桌面，但继续指令未获确认。请检查对话记录后再决定是否重发。${error instanceof Error ? " " + error.message : ""}` }; }
    }
    return grant;
  }
  reset(engine?: RemoteAgentId): void {
    if (!engine || engine === "openhands") { this.hands.shutdown(); this.revoke("openhands"); }
    if (!engine || engine === "openclaw") { this.claw.shutdown(); this.revoke("openclaw"); }
  }
  shutdown(): void { this.reset(); this.proxy?.closeAllConnections(); this.proxy?.close(); this.proxy = undefined; this.proxyOrigin = undefined; this.uploads.clear(); }
}
async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let count = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; count += value.length; if (count > limit) throw new Error("文件超过下载上限"); chunks.push(value); } return Buffer.concat(chunks); }
  finally { await reader.cancel().catch(() => {}); }
}
