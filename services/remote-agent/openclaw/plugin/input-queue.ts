import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type InputMode = "queue" | "steer";
export type InputFile = { name: string; path: string; absolutePath: string };
export type Input = { id: string; text: string; files: InputFile[]; body: string; at: string; phase: string; error: string };
export type InputState = { mode: InputMode; paused: boolean; revision: number; items: Array<{ id: string; text: string; files: Array<{ name: string; path: string }>; at: string; state: "queued" | "sending"; error?: string }> };
export type NativeState = "running" | "waiting" | "idle" | "completed" | "paused" | "error";
export type InputDriver = {
  state(task: string): Promise<NativeState>;
  receipt(task: string, id: string): Promise<"consumed" | "pending" | "interrupted" | "absent">;
  send(task: string, body: string, id: string, steer: boolean, current: () => boolean): Promise<void>;
  stop(task: string): Promise<void>;
};
type Dispatch = { id: string; ids: string; body: string; steer: number; acknowledged: number };
const heldError = "消息尚未提交，待发内容已保留。点击继续后重试。";

/** A server outbox only. Native chat admission, history, tools and approvals remain native. */
export class InputQueue {
  private db: DatabaseSync;
  private locks = new Map<string, Promise<unknown>>();
  private disposed = false;
  private generations = new Map<string, number>();
  constructor(path: string, private readonly driver: InputDriver) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("待发数据库路径无效");
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS input_tasks(task TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'queue', paused INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS inputs(task TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, files TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '', PRIMARY KEY(task,id));
      CREATE TABLE IF NOT EXISTS input_dispatches(task TEXT NOT NULL, id TEXT NOT NULL, ids TEXT NOT NULL, body TEXT NOT NULL, steer INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task,id));
      UPDATE input_tasks SET paused=1, revision=revision+1 WHERE task IN (SELECT task FROM inputs WHERE phase!='done');`);
    if (!this.db.prepare("PRAGMA table_info(input_tasks)").all().some(column => column.name === "deleted")) this.db.exec("ALTER TABLE input_tasks ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  }
  private ensure(task: string): void {
    this.db.prepare("INSERT OR IGNORE INTO input_tasks(task) VALUES(?)").run(task);
    if (this.db.prepare("SELECT deleted FROM input_tasks WHERE task=?").get(task)?.deleted) throw new Error("任务已删除，请新建任务");
  }
  private bump(task: string): void { this.db.prepare("UPDATE input_tasks SET revision=revision+1 WHERE task=?").run(task); }
  private rows(task: string): Input[] {
    return (this.db.prepare("SELECT * FROM inputs WHERE task=? AND phase!='done' ORDER BY rowid").all(task) as unknown as Array<Input & { files: string }>).map(row => ({ ...row, files: JSON.parse(row.files) }));
  }
  state(task: string): InputState {
    this.ensure(task);
    const profile = this.db.prepare("SELECT mode,paused,revision FROM input_tasks WHERE task=?").get(task) as unknown as { mode: InputMode; paused: number; revision: number };
    return { mode: profile.mode, paused: !!profile.paused, revision: profile.revision, items: this.rows(task).map(row => ({ id: row.id, text: row.text, files: row.files.map(({ name, path }) => ({ name, path })), at: row.at, state: row.phase === "sending" ? "sending" : "queued", ...(row.error ? { error: row.error } : {}) })) };
  }
  mode(task: string, mode: InputMode): InputState {
    if (mode !== "queue" && mode !== "steer") throw new Error("发送方式无效");
    if (this.state(task).items.length) throw new Error("请先处理待发消息，再切换默认发送方式");
    this.db.prepare("UPDATE input_tasks SET mode=? WHERE task=?").run(mode, task); this.bump(task); return this.state(task);
  }
  private serial<T>(task: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.locks.get(task) ?? Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(task, operation);
    void operation.finally(() => { if (this.locks.get(task) === operation) this.locks.delete(task); }).catch(() => {});
    return operation;
  }
  private insert(task: string, id: string, text: string, files: InputFile[]): boolean {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || typeof text !== "string" || !Array.isArray(files) || files.length > 10 || (!text.trim() && !files.length)) throw new Error("消息无效");
    const body = text + (files.length ? "\n\n上传文件（远端路径）：\n" + files.map(file => file.absolutePath).join("\n") : "");
    const hash = createHash("sha256").update(JSON.stringify({ text, files })).digest("hex");
    const prior = this.db.prepare("SELECT hash FROM inputs WHERE task=? AND id=?").get(task, id);
    if (prior) { if (prior.hash !== hash) throw new Error("消息标识已用于其他内容"); return false; }
    const rows = this.rows(task);
    if (rows.length >= 20 || rows.reduce((n, row) => n + row.body.length + 2, body.length) > 99_500) throw new Error("待发消息已达上限（20 条或 100,000 字符），请先处理现有消息");
    this.db.prepare("INSERT INTO inputs(task,id,hash,text,files,body,at) VALUES(?,?,?,?,?,?,?)").run(task, id, hash, text, JSON.stringify(files), body, new Date().toISOString()); this.bump(task); return true;
  }
  private pause(task: string, error = ""): void {
    this.ensure(task); this.db.prepare("UPDATE input_tasks SET paused=1 WHERE task=?").run(task);
    if (error) this.db.prepare("UPDATE inputs SET error=? WHERE task=? AND phase!='done'").run(error, task);
    this.bump(task);
  }
  private dispatches(task: string): Dispatch[] { return this.db.prepare("SELECT * FROM input_dispatches WHERE task=? ORDER BY rowid").all(task) as unknown as Dispatch[]; }
  private settle(task: string, dispatch: Dispatch): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of JSON.parse(dispatch.ids) as string[]) this.db.prepare("UPDATE inputs SET phase='done',text='',files='[]',body='',error='' WHERE task=? AND id=?").run(task, id);
      this.db.prepare("DELETE FROM input_dispatches WHERE task=? AND id=?").run(task, dispatch.id); this.bump(task); this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private async reconcile(task: string): Promise<boolean> {
    for (const operation of this.dispatches(task)) {
      const receipt = await this.driver.receipt(task, operation.id);
      if (receipt === "consumed") { this.settle(task, operation); continue; }
      if (receipt === "interrupted") {
        for (const id of JSON.parse(operation.ids) as string[]) this.db.prepare("UPDATE inputs SET phase='queued',error=? WHERE task=? AND id=?").run(heldError, task, id);
        this.db.prepare("DELETE FROM input_dispatches WHERE task=? AND id=?").run(task, operation.id); this.pause(task);
      }
    }
    return this.dispatches(task).length === 0;
  }
  private async deliver(task: string, rows: Input[], steer: boolean, prefix = "", retry?: Dispatch): Promise<void> {
    const generation = this.generations.get(task) ?? 0;
    let operation = retry;
    if (!operation) {
      operation = { id: randomUUID(), ids: JSON.stringify(rows.map(row => row.id)), body: prefix + rows.map(row => row.body).join("\n\n"), steer: steer ? 1 : 0, acknowledged: 0 };
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("INSERT INTO input_dispatches(task,id,ids,body,steer) VALUES(?,?,?,?,?)").run(task, operation.id, operation.ids, operation.body, operation.steer);
        for (const row of rows) this.db.prepare("UPDATE inputs SET phase='sending',error='' WHERE task=? AND id=?").run(task, row.id);
        this.bump(task); this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    try {
      await this.driver.send(task, operation.body, operation.id, !!operation.steer, () => !this.disposed && (this.generations.get(task) ?? 0) === generation);
      this.db.prepare("UPDATE input_dispatches SET acknowledged=1 WHERE task=? AND id=?").run(task, operation.id);
      await this.reconcile(task);
    } catch { this.pause(task, heldError); }
  }
  async send(task: string, id: string, text: string, files: InputFile[], mode: InputMode): Promise<InputState> {
    if (mode !== "queue" && mode !== "steer") throw new Error("发送方式无效");
    return this.serial(task, async () => {
      const hadPending = this.rows(task).length > 0;
      this.ensure(task); if (!this.insert(task, id, text, files)) return this.state(task);
      try {
        const status = await this.driver.state(task), busy = status === "running" || status === "waiting";
        await this.reconcile(task);
        if ((status === "paused" || status === "error") && hadPending) this.pause(task);
        if (mode === "steer" && busy) await this.deliver(task, this.rows(task).filter(row => row.id === id), true);
        else if (!busy && !hadPending && !this.dispatches(task).length) {
          // A fresh explicit request is not an automatic retry of a held queue.
          this.db.prepare("UPDATE input_tasks SET paused=0 WHERE task=?").run(task); this.bump(task);
          await this.deliver(task, this.rows(task), false);
        }
        else if (!busy && !this.state(task).paused && !this.dispatches(task).length) await this.deliver(task, this.rows(task), false);
      } catch { this.pause(task, heldError); }
      return this.state(task);
    });
  }
  async action(task: string, id: string, action: "remove" | "steer"): Promise<InputState> {
    return this.serial(task, async () => {
      const row = this.rows(task).find(row => row.id === id); if (!row) throw new Error("待发消息已提交或已删除");
      if (row.phase === "sending") throw new Error("这条消息正在提交，不能重复操作");
      if (action === "remove") { this.db.prepare("UPDATE inputs SET phase='done',text='',files='[]',body='',error='' WHERE task=? AND id=?").run(task, id); this.bump(task); }
      else {
        const status = await this.driver.state(task);
        if (!["running", "waiting"].includes(status)) throw new Error("当前没有可补充的工作轮次");
        await this.deliver(task, [row], true);
      }
      return this.state(task);
    });
  }
  async control(task: string, action: "stop" | "resume"): Promise<InputState> {
    if (action === "stop") { this.pause(task); this.generations.set(task, (this.generations.get(task) ?? 0) + 1); }
    return this.serial(task, async () => {
      if (action === "stop") { await this.driver.stop(task); await this.reconcile(task); }
      else {
        this.ensure(task); await this.reconcile(task);
        const status = await this.driver.state(task);
        if (["running", "waiting"].includes(status)) {
          if (this.state(task).paused) throw new Error("当前操作尚未停止，请稍后继续");
          return this.state(task);
        }
        this.db.prepare("UPDATE input_tasks SET paused=0 WHERE task=?").run(task); this.bump(task);
        const operations = this.dispatches(task);
        for (const operation of operations) if (!operation.acknowledged) await this.deliver(task, [], !!operation.steer, "", operation);
        if (!operations.length && !["running", "waiting"].includes(status)) await this.deliver(task, this.rows(task), false, "继续当前任务；先核对已有进度与产物，不要重复已完成的操作。\n\n");
      }
      return this.state(task);
    });
  }
  async tick(): Promise<void> {
    if (this.disposed) return;
    const tasks = this.db.prepare("SELECT task FROM input_tasks WHERE task IN (SELECT task FROM inputs WHERE phase!='done') OR task IN (SELECT task FROM input_dispatches)").all() as Array<{ task: string }>;
    await Promise.all(tasks.map(({ task }) => this.serial(task, async () => {
      try {
        if (!this.db.prepare("SELECT task FROM input_tasks WHERE task=? AND deleted=0").get(task)) return;
        if (!await this.reconcile(task) || this.state(task).paused) return;
        const status = await this.driver.state(task);
        if (status === "paused" || status === "error") { this.pause(task); return; }
        if (status === "running" || status === "waiting") return;
        const rows = this.rows(task); if (rows.length) await this.deliver(task, rows, false);
      } catch { this.pause(task, heldError); }
    })));
  }
  failed(task: string): void { if (!this.disposed && this.db.prepare("SELECT task FROM input_tasks WHERE task=? AND deleted=0").get(task)) this.pause(task); }
  async clear(task: string): Promise<void> {
    if (this.db.prepare("SELECT deleted FROM input_tasks WHERE task=?").get(task)?.deleted) return;
    this.pause(task); this.generations.set(task, (this.generations.get(task) ?? 0) + 1);
    await this.serial(task, async () => {
      this.db.prepare("DELETE FROM inputs WHERE task=?").run(task); this.db.prepare("DELETE FROM input_dispatches WHERE task=?").run(task);
      // Retain only the task-id tombstone, never deleted input content. It
      // prevents a delayed Send/GET from recreating a permanently deleted task.
      this.db.prepare("UPDATE input_tasks SET deleted=1,paused=1,mode='queue',revision=revision+1 WHERE task=?").run(task);
    });
  }
  async close(): Promise<void> { this.disposed = true; await Promise.allSettled([...this.locks.values()]); this.db.close(); }
}
