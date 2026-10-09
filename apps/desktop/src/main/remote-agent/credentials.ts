import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RemoteAgentId } from "../../../../../packages/contracts/src/remote-agent";
import { createOpenClawIdentity, validOpenClawIdentity, type OpenClawIdentity } from "../../../../../packages/remote-agent/src/openclaw/gateway";

export interface RemoteCredentials { sessionApiKey: string; persistenceKey: string; device?: OpenClawIdentity }
export interface CredentialEncryption {
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}

/** Development pairing, not an account/login system. Never shared or bundled. */
export class RemoteServiceCredentials {
  private pending: Promise<RemoteCredentials> | undefined;
  constructor(private readonly root: string, private readonly encryption: CredentialEncryption, private readonly engine: RemoteAgentId = "openhands") {}

  get(): Promise<RemoteCredentials> {
    if (!this.pending) this.pending = this.load().catch((error) => { this.pending = undefined; throw error; });
    return this.pending;
  }

  private async load(): Promise<RemoteCredentials> {
    const path = join(this.root, `${this.engine}-service-credentials.json`);
    try {
      const stored = JSON.parse(await readFile(path, "utf8")) as { version: number; encrypted: string };
      if (stored.version !== 1 || typeof stored.encrypted !== "string") throw new Error("远端服务连接凭据损坏，请勿删除服务数据");
      const credentials = JSON.parse(await this.encryption.decrypt(Buffer.from(stored.encrypted, "base64"))) as RemoteCredentials;
      if (!/^[a-f0-9]{64}$/.test(credentials.sessionApiKey) || !/^[\w-]{43}=$/.test(credentials.persistenceKey)) throw new Error("远端服务连接凭据格式无效");
      if (this.engine === "openclaw" && !credentials.device) throw new Error("OpenClaw 设备身份缺失，未自动替换已有凭据");
      if (credentials.device && !validOpenClawIdentity(credentials.device)) throw new Error("OpenClaw 设备身份损坏，未自动替换已有凭据");
      return credentials;
    } catch (error) {
      // Never regenerate on decryption/corruption: it would strand server-encrypted history.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const credentials: RemoteCredentials = {
      sessionApiKey: randomBytes(32).toString("hex"),
      persistenceKey: `${randomBytes(32).toString("base64url")}=` ,
      ...(this.engine === "openclaw" ? { device: createOpenClawIdentity() } : {}),
    };
    const encrypted = (await this.encryption.encrypt(JSON.stringify(credentials))).toString("base64");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, encrypted }), { mode: 0o600 });
    await rename(temporary, path);
    return credentials;
  }
}
