import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { OllamaClient } from "../../../../packages/runtime/src/ollama";

async function freeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配本地模型服务端口");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/** Owns only our embedded Ollama process, never a user's separately installed service. */
export class OllamaProcess {
  private child: ChildProcess | null = null;
  private client: OllamaClient | null = null;
  private starting: Promise<OllamaClient> | null = null;
  private directory: string | null = null;
  private log = "";
  private stopping = false;
  constructor(private readonly executable: string, private readonly onExit: (message: string) => void = () => {}) {}

  start(modelsDirectory: string): Promise<OllamaClient> {
    if (this.stopping) return Promise.reject(new Error("本地模型服务正在停止，请稍后重试"));
    if (this.client && this.child && this.child.exitCode === null && this.directory === modelsDirectory) return Promise.resolve(this.client);
    if (this.starting) return this.starting;
    this.starting = this.launch(modelsDirectory).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async launch(modelsDirectory: string): Promise<OllamaClient> {
    await access(this.executable).catch(() => { throw new Error("内置 Ollama 运行包缺失，请重新打包或运行 npm run ensure:ollama"); });
    const port = await freeLocalPort();
    if (this.stopping) throw new Error("本地模型服务已停止");
    this.log = "";
    const child = spawn(this.executable, ["serve"], {
      cwd: dirname(this.executable), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: modelsDirectory, OLLAMA_NO_CLOUD: "1", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_NUM_PARALLEL: "1" },
    });
    this.child = child;
    this.directory = modelsDirectory;
    let spawnError: Error | null = null;
    child.once("error", (error) => { spawnError = error; });
    const collect = (chunk: Buffer): void => { this.log = (this.log + chunk.toString()).slice(-6000); };
    child.stdout?.on("data", collect); child.stderr?.on("data", collect);
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null; this.client = null;
      if (!this.stopping) this.onExit(`本地模型服务已退出（${signal ?? code}）`);
    });
    const client = new OllamaClient(`http://127.0.0.1:${port}`);
    const deadline = Date.now() + 30000;
    try {
      while (Date.now() < deadline) {
        if (this.stopping) throw new Error("本地模型服务已停止");
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Ollama 启动失败：${this.log.slice(-1500)}`);
        try {
          await client.version(AbortSignal.timeout(750));
          this.client = client;
          return client;
        } catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
      }
      throw new Error(`Ollama 启动超时：${this.log.slice(-1000)}`);
    } catch (error) { await this.killChild(child); throw error; }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    try {
      if (this.child) await this.killChild(this.child);
      await this.starting?.catch(() => {});
      this.child = null; this.client = null; this.directory = null;
    } finally { this.stopping = false; }
  }

  private async killChild(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const kill = (signal: NodeJS.Signals): void => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); } catch { /* group may already be gone */ }
      try { child.kill(signal); } catch { /* already exited */ }
    };
    await new Promise<void>((resolve, reject) => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => { kill("SIGKILL"); deadline = setTimeout(() => reject(new Error("内置 Ollama 未能退出")), 1000); }, 2500);
      child.once("exit", () => { clearTimeout(timer); clearTimeout(deadline); resolve(); });
      kill("SIGTERM");
    });
  }
}
