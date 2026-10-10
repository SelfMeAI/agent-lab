import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import type { RemoteAgentId, RemoteServiceState } from "../../../../../packages/contracts/src/remote-agent";
import { GatewayRequestError, openClawRpc } from "../../../../../packages/remote-agent/src/openclaw/gateway";
import type { RemoteCredentials } from "./credentials";
import { remoteDeployments, redactServiceOutput } from "./deployment";

export const OPENHANDS_VERSION = remoteDeployments.openhands.version;
export const OPENHANDS_IMAGE = remoteDeployments.openhands.image;
const ownerLabel = "ai.selfme.lab.owner";
const deploymentLabel = "ai.selfme.lab.deployment";
type Container = { Config: { Image: string; Labels: Record<string, string> }; State: { Running: boolean }; Mounts: Array<{ Type: string; Name?: string; Destination: string }>; NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> } };

export function containerEndpoint(container: Container, owner: string, volume: string, engine: RemoteAgentId = "openhands"): string | null {
  const deployment = remoteDeployments[engine];
  if (container.Config.Labels?.[ownerLabel] !== owner || ![deployment.image, ...deployment.legacyImages].includes(container.Config.Image)) throw new Error("同名容器不属于当前实验服务，未作修改");
  if (container.Mounts.length !== 1 || !container.Mounts.some(mount => mount.Type === "volume" && mount.Name === volume && mount.Destination === deployment.mount)) throw new Error("服务挂载不符合远端工作区隔离规则，未作修改");
  if (!container.State.Running) return null;
  const bindings = container.NetworkSettings.Ports[`${deployment.port}/tcp`];
  if (bindings?.length !== 1 || bindings[0].HostIp !== "127.0.0.1") throw new Error("研发服务必须只绑定本机回环地址");
  const port = Number(bindings[0].HostPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("服务端口无效");
  return `http://127.0.0.1:${port}`;
}

/** Development lifecycle ONLY. Tasks, model settings and files use native APIs. */
export class RemoteAgentContainer {
  private docker: string | undefined;
  private operation: Promise<RemoteServiceState> | undefined;
  private phase: RemoteServiceState["phase"] = "stopped";
  private detail = "研发服务未启动";
  private readonly deployment;
  readonly owner: string;
  readonly name: string;
  readonly volume: string;
  readonly deploymentRevision: string;

  constructor(root: string, private readonly credentials: () => Promise<RemoteCredentials>, readonly engine: RemoteAgentId = "openhands") {
    this.deployment = remoteDeployments[engine];
    this.owner = createHash("sha256").update(root).digest("hex").slice(0, 16);
    this.name = `selfme-lab-${engine}-${this.owner}`;
    this.volume = `${this.name}-data`;
    this.deploymentRevision = createHash("sha256").update(JSON.stringify({ image: this.deployment.image, command: this.deployment.command })).digest("hex").slice(0, 16);
  }

  private async binary(): Promise<string> {
    if (this.docker) return this.docker;
    for (const candidate of ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"]) {
      try { await access(candidate); this.docker = candidate; return candidate; } catch { /* next supported location */ }
    }
    throw new Error("未找到 Docker，请安装并启动 Docker Desktop");
  }
  private async command(args: string[], env?: NodeJS.ProcessEnv, timeout = 30_000, includeStderr = false): Promise<string> {
    const executable = await this.binary();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = ""; let combined = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("Docker 操作超时，请查看服务日志")); }, timeout);
      child.stdout.on("data", (value: Buffer) => { stdout = (stdout + value.toString()).slice(-128_000); combined = (combined + value.toString()).slice(-128_000); });
      child.stderr.on("data", (value: Buffer) => { stderr = (stderr + value.toString()).slice(-16_000); combined = (combined + value.toString()).slice(-128_000); });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(includeStderr ? combined : stdout); else reject(new Error(redactServiceOutput(stderr.trim()) || `Docker 操作失败（${code}）`)); });
    });
  }
  private async inspect(): Promise<Container | null> {
    try { return (JSON.parse(await this.command(["inspect", this.name])) as Container[])[0] ?? null; }
    catch (error) { if (/No such (?:object|container)/i.test(String(error))) return null; throw error; }
  }
  private endpoint(container: Container): string | null { return containerEndpoint(container, this.owner, this.volume, this.engine); }
  private async checkImage(): Promise<void> {
    const labels = JSON.parse(await this.command(["image", "inspect", "--format", "{{json .Config.Labels}}", this.deployment.image], undefined, 8000)) as Record<string, string> | null;
    if (labels?.["ai.selfme.lab.source.commit"] !== this.deployment.commit || labels?.["ai.selfme.lab.engine"] !== this.engine || labels?.["ai.selfme.lab.integration"] !== "1") throw new Error("服务镜像的源码或部署层标识不匹配，请重新构建固定源码镜像");
  }

  /** Status reads do not silently approve devices. Pairing happens on explicit Start. */
  private async health(endpoint: string, keys: RemoteCredentials): Promise<void> {
    if (this.engine === "openclaw") {
      if (!keys.device) throw new Error("OpenClaw 设备身份缺失");
      await openClawRpc(endpoint, keys.sessionApiKey, keys.device, "health", {}, 6000);
    } else {
      // /server/info is public and is not mounted below /api. Use a protected
      // native endpoint so "ready" proves authentication, not merely liveness.
      const response = await fetch(`${endpoint}/api/settings`, { headers: { "X-Session-API-Key": keys.sessionApiKey }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "服务认证失败，未关闭鉴权" : `服务健康检查失败（${response.status}）`);
    }
  }

  async state(): Promise<RemoteServiceState> {
    let dockerAvailable = false; let imageReady = false; let endpoint: string | null = null; let running = false;
    let setupWarning: string | undefined;
    try {
      await this.command(["info", "--format", "{{.ServerVersion}}"], undefined, 8000); dockerAvailable = true;
      try { await this.checkImage(); imageReady = true; } catch { /* explicit source build */ }
      const container = await this.inspect();
      if (container) {
        endpoint = this.endpoint(container); running = container.State.Running;
        if (running && (container.Config.Image !== this.deployment.image || container.Config.Labels?.[deploymentLabel] !== this.deploymentRevision)) setupWarning = "服务部署有更新，请空闲时重启此服务；任务、模型连接和文件会保留。";
      }
      if (!this.operation) {
        if (endpoint) { await this.health(endpoint, await this.credentials()); this.phase = "ready"; this.detail = "服务已连接 · 自动验证"; }
        else { this.phase = "stopped"; this.detail = "服务未启动 · 数据保留在服务卷中"; }
      }
    } catch (error) {
      if (!this.operation) { this.phase = "error"; this.detail = redactServiceOutput(error instanceof Error ? error.message : String(error)); }
    }
    return { phase: this.phase, running, dockerAvailable, imageReady, version: this.deployment.version, endpoint, detail: this.detail, ...(setupWarning ? { setupWarning } : {}) };
  }

  control(action: "start" | "stop" | "restart"): Promise<RemoteServiceState> {
    if (this.operation) return Promise.reject(new Error("服务正在处理中，请等待操作完成"));
    this.phase = action === "stop" ? "stopping" : "starting";
    this.detail = action === "stop" ? "正在停止服务" : "正在启动并验证服务";
    this.operation = (async () => {
      if (action !== "start") await this.doStop();
      if (action !== "stop") await this.doStart();
    })().then(() => { this.operation = undefined; return this.state(); }, error => {
      this.operation = undefined; this.phase = "error"; this.detail = redactServiceOutput(error instanceof Error ? error.message : String(error));
      throw new Error(this.detail);
    });
    return this.operation;
  }
  start(): Promise<RemoteServiceState> { return this.control("start"); }
  stop(): Promise<RemoteServiceState> { return this.control("stop"); }
  restart(): Promise<RemoteServiceState> { return this.control("restart"); }

  private async doStart(): Promise<void> {
    await this.command(["info", "--format", "{{.ServerVersion}}"]);
    const keys = await this.credentials();
    try { await this.checkImage(); }
    catch { throw new Error(`尚未构建固定源码服务镜像，请运行 npm run remote:build -- ${this.engine}`); }
    let previous = await this.inspect();
    if (previous && (previous.Config.Image !== this.deployment.image || previous.Config.Labels[deploymentLabel] !== this.deploymentRevision)) {
      this.endpoint(previous);
      if (previous.State.Running) await this.command(["stop", "--time", "20", this.name]);
      // Replace ONLY this verified owned container after a deployment upgrade,
      // never its native settings/history/files volume.
      await this.command(["rm", this.name]); previous = null;
    }
    if (previous) {
      this.endpoint(previous);
      if (!previous.State.Running) await this.command(["start", this.name]);
    } else {
      try {
        const volume = JSON.parse(await this.command(["volume", "inspect", this.volume])) as Array<{ Labels: Record<string, string> }>;
        if (volume[0]?.Labels?.[ownerLabel] !== this.owner) throw new Error("同名服务卷不属于当前应用，未作修改");
      } catch (error) {
        if (!/no such volume/i.test(String(error))) throw error;
        await this.command(["volume", "create", "--label", `${ownerLabel}=${this.owner}`, this.volume]);
      }
      const env: NodeJS.ProcessEnv = this.engine === "openhands"
        ? { OH_SESSION_API_KEYS_0: keys.sessionApiKey, OH_SECRET_KEY: keys.persistenceKey }
        : { OPENCLAW_GATEWAY_TOKEN: keys.sessionApiKey };
      const envArgs = this.engine === "openhands" ? [
        "OH_SESSION_API_KEYS_0", "OH_SECRET_KEY", "OH_CONVERSATIONS_PATH=/workspace/selfme/conversations",
        "OH_BASH_EVENTS_DIR=/workspace/selfme/bash", "OH_PERSISTENCE_DIR=/workspace/selfme/settings", "OPENHANDS_SUPPRESS_BANNER=1",
      ] : [
        "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_NO_RESPAWN=1", "OPENCLAW_SKIP_CHANNELS=1", "OPENCLAW_SKIP_CRON=1",
        "OPENCLAW_SKIP_GMAIL_WATCHER=1", "OPENCLAW_CODEX_DISCOVERY_LIVE=0",
      ];
      await this.command([
        "run", "--detach", "--name", this.name, "--label", `${ownerLabel}=${this.owner}`, "--label", `${deploymentLabel}=${this.deploymentRevision}`,
        "--publish", `127.0.0.1::${this.deployment.port}`, "--mount", `type=volume,src=${this.volume},dst=${this.deployment.mount}`,
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "1024", "--shm-size", "256m",
        ...envArgs.flatMap(value => ["--env", value]), this.deployment.image, ...this.deployment.command,
      ], env);
    }
    const deadline = Date.now() + 90_000;
    let lastError: unknown; let paired = false;
    while (Date.now() < deadline) {
      const current = await this.inspect();
      const endpoint = current && this.endpoint(current);
      if (current && !current.State.Running) throw new Error(`${this.deployment.name} 服务启动后退出，请查看日志`);
      if (endpoint) {
        try { await this.health(endpoint, keys); return; }
        catch (error) {
          lastError = error;
          // Approve ONLY the exact signed request returned by our own handshake.
          // No --latest, no auth-disabled mode, no unsolicited devices approved.
          if (this.engine === "openclaw" && !paired && error instanceof GatewayRequestError && error.code === "NOT_PAIRED") {
            const requestId = error.details?.requestId;
            if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/.test(requestId) || error.details?.deviceId !== keys.device?.deviceId) throw error;
            await this.command(["exec", this.name, "node", "/app/openclaw.mjs", "devices", "approve", requestId, "--json"], undefined, 30_000);
            paired = true;
          } else if (/认证失败|UNAUTHORIZED|unauthorized/i.test(String(error))) throw error;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    throw new Error(`${this.deployment.name} 服务启动超时：${lastError instanceof Error ? lastError.message : "请查看日志"}`);
  }

  private async doStop(): Promise<void> {
    const container = await this.inspect();
    if (container) { this.endpoint(container); if (container.State.Running) await this.command(["stop", "--time", "20", this.name]); }
  }
  async requireEndpoint(): Promise<string> {
    if (this.operation) throw new Error("服务正在启动或停止，请稍后再试");
    const current = await this.state();
    if (current.phase !== "ready" || !current.endpoint) throw new Error(current.detail);
    return current.endpoint;
  }
  async logs(): Promise<string> {
    const container = await this.inspect();
    if (!container) return "暂无服务日志";
    this.endpoint(container);
    const keys = await this.credentials();
    const value = await this.command(["logs", "--tail", "100", this.name], undefined, 15_000, true);
    return redactServiceOutput(value, [keys.sessionApiKey, keys.persistenceKey]);
  }
}
