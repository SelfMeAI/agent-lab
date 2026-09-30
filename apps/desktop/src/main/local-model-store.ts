import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LocalModelParameters, LocalModelPreferences, LocalModelRun, LocalModelRunSummary } from "../../../../packages/contracts/src/local-model";
import { validLocalModelName } from "../../../../packages/runtime/src/ollama";

export const defaultLocalModelParameters: LocalModelParameters = { temperature: 0.7, contextLength: 4096, seed: null, maxTokens: 2048, thinking: "auto" };

export function validateLocalModelParameters(value: unknown): LocalModelParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("实验参数格式无效");
  const p = value as LocalModelParameters;
  if (!Number.isFinite(p.temperature) || p.temperature < 0 || p.temperature > 2) throw new Error("Temperature 必须在 0–2 之间");
  if (!Number.isInteger(p.contextLength) || p.contextLength < 512 || p.contextLength > 131072) throw new Error("上下文长度必须是 512–131072 之间的整数");
  if (!Number.isInteger(p.maxTokens) || p.maxTokens < 1 || p.maxTokens > 32768) throw new Error("输出上限必须是 1–32768 之间的整数");
  if (p.seed !== null && (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 2147483647)) throw new Error("Seed 必须留空或是 0–2147483647 之间的整数");
  if (p.thinking !== "auto" && p.thinking !== "off") throw new Error("思考设置无效");
  return { temperature: p.temperature, contextLength: p.contextLength, seed: p.seed, maxTokens: p.maxTokens, thinking: p.thinking };
}

export function validateLocalModelPreferences(value: unknown): LocalModelPreferences {
  if (!value || typeof value !== "object") throw new Error("模型配置格式无效");
  const p = value as LocalModelPreferences;
  for (const name of [p.selectedModel, p.modelA, p.modelB]) if (name !== null && !validLocalModelName(name)) throw new Error("模型名称无效");
  return { selectedModel: p.selectedModel, modelA: p.modelA, modelB: p.modelB, parameters: validateLocalModelParameters(p.parameters) };
}

/** Weights are independent of the package; experiment evidence lives in SQLite, defaults in JSON. */
export class LocalModelStore {
  private db: DatabaseSync | null = null;
  private config: { version: 1; modelsDirectory: string; preferences: LocalModelPreferences };
  private pendingWrite: Promise<void> = Promise.resolve();
  constructor(private readonly root: string) {
    this.config = { version: 1, modelsDirectory: join(root, "local-models"), preferences: { selectedModel: null, modelA: null, modelB: null, parameters: { ...defaultLocalModelParameters } } };
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const c = JSON.parse(await readFile(join(this.root, "local-model-config.json"), "utf8"));
      if (c.version !== 1 || !isAbsolute(c.modelsDirectory)) throw new Error("本地模型配置文件无效");
      this.config = { version: 1, modelsDirectory: c.modelsDirectory, preferences: validateLocalModelPreferences(c.preferences) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.writeConfig();
    }
    await mkdir(this.config.modelsDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.root, "local-model-runs.sqlite");
    this.db = new DatabaseSync(path, { timeout: 3000 });
    await chmod(path, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS local_model_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS local_model_runs_recent ON local_model_runs(created_at DESC);`);
    for (const row of this.db.prepare("SELECT payload FROM local_model_runs WHERE status IN ('pending', 'running')").all()) {
      const run = JSON.parse(String(row.payload)) as LocalModelRun;
      run.status = "interrupted";
      run.completedAt = new Date().toISOString();
      for (const output of run.outputs) if (output.status === "running" || output.status === "pending") {
        output.status = "interrupted"; output.error = "上次运行随应用退出而中断，可重新运行";
      }
      this.saveRun(run);
    }
  }

  get modelsDirectory(): string { return this.config.modelsDirectory; }
  get preferences(): LocalModelPreferences { return structuredClone(this.config.preferences); }

  async savePreferences(value: unknown): Promise<LocalModelPreferences> {
    this.config.preferences = validateLocalModelPreferences(value);
    await this.writeConfig();
    return this.preferences;
  }

  async setModelsDirectory(path: string): Promise<void> {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("请选择有效的模型目录");
    await mkdir(path, { recursive: true, mode: 0o700 });
    this.config.modelsDirectory = path;
    await this.writeConfig();
  }

  saveRun(run: LocalModelRun): void {
    this.database().prepare("INSERT INTO local_model_runs (id, created_at, status, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload")
      .run(run.id, run.createdAt, run.status, JSON.stringify(run));
  }

  getRun(id: string): LocalModelRun {
    if (typeof id !== "string" || id.length > 100) throw new Error("实验编号无效");
    const row = this.database().prepare("SELECT payload FROM local_model_runs WHERE id = ?").get(id);
    if (!row) throw new Error("实验记录不存在");
    return JSON.parse(String(row.payload)) as LocalModelRun;
  }

  latest(): LocalModelRun | null {
    const row = this.database().prepare("SELECT payload FROM local_model_runs ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
    return row ? JSON.parse(String(row.payload)) as LocalModelRun : null;
  }

  history(): LocalModelRunSummary[] {
    return this.database().prepare("SELECT payload FROM local_model_runs ORDER BY created_at DESC, rowid DESC LIMIT 200").all().map((row) => {
      const r = JSON.parse(String(row.payload)) as LocalModelRun;
      return { id: r.id, mode: r.mode, prompt: r.prompt.slice(0, 160), models: r.outputs.map((o) => o.model), createdAt: r.createdAt, status: r.status };
    });
  }

  deleteRun(id: string): void { this.getRun(id); this.database().prepare("DELETE FROM local_model_runs WHERE id = ?").run(id); }
  async close(): Promise<void> { await this.pendingWrite; this.db?.close(); this.db = null; }
  private database(): DatabaseSync { if (!this.db) throw new Error("实验数据库尚未启动"); return this.db; }

  private writeConfig(): Promise<void> {
    const contents = JSON.stringify(this.config, null, 2);
    const write = this.pendingWrite.then(async () => {
      const temporary = join(this.root, `local-model-config-${randomUUID()}.tmp`);
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, join(this.root, "local-model-config.json"));
    });
    this.pendingWrite = write.catch(() => {});
    return write;
  }
}
