import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRuntimeId, AgentSessionEvent, AgentSessionSummary, RunEvent, RuntimePhase } from "../../../../packages/contracts/src/index";

export interface StoredAgentSession extends AgentSessionSummary {
  nativeRef: string | null;
  deletedAt: string | null;
}

const runtimeIds = new Set<AgentRuntimeId>(["dsh", "codex", "pi", "kimi-code"]);
// Connection/status events can occur without user-visible work, so they do not
// count as conversation activity in the session rail.
const lastActivitySql = `(
  SELECT json_extract(agent_events.payload, '$.at') FROM agent_events
  WHERE agent_events.session_id = agent_sessions.id
    AND json_extract(agent_events.payload, '$.kind') IN ('user', 'message', 'tool', 'approval', 'artifact', 'error')
  ORDER BY agent_events.event_index DESC LIMIT 1
) AS last_activity_at`;

function summary(record: StoredAgentSession): AgentSessionSummary {
  const { nativeRef: _nativeRef, deletedAt: _deletedAt, ...visible } = record;
  return visible;
}

function fromRow(row: Record<string, unknown>): StoredAgentSession {
  return {
    id: String(row.id), runtimeId: String(row.runtime_id) as AgentRuntimeId,
    workspace: String(row.workspace), title: String(row.title),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    lastPromptAt: row.last_prompt_at == null ? null : String(row.last_prompt_at),
    lastActivityAt: row.last_activity_at == null ? null : String(row.last_activity_at),
    phase: String(row.phase) as RuntimePhase, statusText: String(row.status_text),
    nativeRef: row.native_ref === null ? null : String(row.native_ref),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

/** App-owned session index and transcript. Harness-native context stays in each runtime home. */
export class AgentSessionRepository {
  private db: DatabaseSync | null = null;
  private readonly nextEventIndex = new Map<string, number>();

  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, "agent-sessions.sqlite");
    const db = new DatabaseSync(path, { timeout: 3000 });
    this.db = db;
    await chmod(path, 0o600);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        phase TEXT NOT NULL,
        status_text TEXT NOT NULL,
        native_ref TEXT,
        last_prompt_at TEXT,
        deleted_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_events (
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        event_index INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, event_index)
      ) STRICT;
    `);
    const columns = new Set(db.prepare("PRAGMA table_info(agent_sessions)").all().map((row) => String(row.name)));
    if (!columns.has("last_prompt_at")) db.exec("ALTER TABLE agent_sessions ADD COLUMN last_prompt_at TEXT");
    if (!columns.has("deleted_at")) db.exec("ALTER TABLE agent_sessions ADD COLUMN deleted_at TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS agent_sessions_recent ON agent_sessions(runtime_id, deleted_at, COALESCE(last_prompt_at, created_at) DESC, created_at DESC)");
    // Existing databases did not track prompt time separately. Recover it
    // once from the transcript instead of mistaking later status events for work.
    db.prepare(`UPDATE agent_sessions SET last_prompt_at = (
      SELECT json_extract(payload, '$.at') FROM agent_events
      WHERE session_id = agent_sessions.id AND json_extract(payload, '$.kind') = 'user'
      ORDER BY event_index DESC LIMIT 1
    ) WHERE last_prompt_at IS NULL AND EXISTS (
      SELECT 1 FROM agent_events WHERE session_id = agent_sessions.id AND json_extract(payload, '$.kind') = 'user'
    )`).run();
    db.prepare("UPDATE agent_sessions SET phase = 'idle', status_text = '上次运行已中断，可继续会话' WHERE phase IN ('starting', 'running', 'approval', 'cancelling')").run();
    // Persist recovery receipts as events too: a restart must not leave a false
    // 'waiting' badge, nor re-send unconfirmed steering into a future task.
    const pending = db.prepare(`SELECT payload FROM agent_events u
      WHERE json_extract(u.payload, '$.deliveryMode') = 'steer'
      AND NOT EXISTS (SELECT 1 FROM agent_events d WHERE d.session_id = u.session_id
        AND json_extract(d.payload, '$.kind') = 'delivery'
        AND json_extract(d.payload, '$.messageId') = json_extract(u.payload, '$.messageId')
        AND json_extract(d.payload, '$.deliveryState') IN ('incorporated', 'unconfirmed', 'rejected'))
      AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = u.session_id AND s.deleted_at IS NULL)`).all();
    for (const row of pending) {
      const event = JSON.parse(String(row.payload)) as AgentSessionEvent;
      this.append(event.sessionId, { runtimeId: event.runtimeId, runId: event.runId, sequence: 0, at: new Date().toISOString(), source: "SelfMe Lab",
        kind: "delivery", messageId: event.messageId, deliveryState: "unconfirmed", text: "上次连接已中断，未确认接入；不会自动重发" });
    }
  }

  close(): void { this.db?.close(); this.db = null; }

  list(runtimeId: AgentRuntimeId): AgentSessionSummary[] {
    return this.database().prepare(`SELECT agent_sessions.*, ${lastActivitySql} FROM agent_sessions
      WHERE runtime_id = ? AND deleted_at IS NULL
      ORDER BY COALESCE(last_prompt_at, created_at) DESC, created_at DESC, rowid DESC`)
      .all(runtimeId).map((row) => summary(fromRow(row)));
  }

  listDeleted(runtimeId: AgentRuntimeId): AgentSessionSummary[] {
    return this.database().prepare(`SELECT agent_sessions.*, ${lastActivitySql} FROM agent_sessions
      WHERE runtime_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC`)
      .all(runtimeId).map((row) => summary(fromRow(row)));
  }

  get(id: string, includeDeleted = false): StoredAgentSession {
    const row = this.database().prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id);
    if (!row) throw new Error("会话不存在或已删除");
    const record = fromRow(row);
    if (record.deletedAt && !includeDeleted) throw new Error("会话已移至最近删除，请先恢复");
    return record;
  }

  create(runtimeId: AgentRuntimeId, workspace: string): AgentSessionSummary {
    if (!runtimeIds.has(runtimeId)) throw new Error("此运行时暂不支持会话");
    const now = new Date().toISOString();
    const record: StoredAgentSession = {
      id: randomUUID(), runtimeId, workspace, title: "新会话", createdAt: now, updatedAt: now,
      phase: "idle", statusText: "尚未连接", nativeRef: null,
      lastPromptAt: null, lastActivityAt: null, deletedAt: null,
    };
    this.database().prepare(`INSERT INTO agent_sessions
      (id, runtime_id, workspace, title, created_at, updated_at, phase, status_text, native_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(record.id, record.runtimeId, record.workspace, record.title, now, now, record.phase, record.statusText);
    this.nextEventIndex.set(record.id, 1);
    return summary(record);
  }

  setNativeRef(id: string, nativeRef: string): void {
    this.get(id);
    this.database().prepare("UPDATE agent_sessions SET native_ref = ? WHERE id = ?").run(nativeRef, id);
  }

  softDelete(id: string): StoredAgentSession {
    const record = this.get(id);
    this.database().prepare("UPDATE agent_sessions SET deleted_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return record;
  }

  restore(id: string): AgentSessionSummary {
    const record = this.get(id, true);
    if (!record.deletedAt) throw new Error("会话未被删除");
    this.database().prepare("UPDATE agent_sessions SET deleted_at = NULL, phase = 'idle', status_text = '已恢复，可继续会话' WHERE id = ?").run(id);
    return summary(this.get(id));
  }

  purge(id: string): void {
    const record = this.get(id, true);
    if (!record.deletedAt) throw new Error("请先将会话移至最近删除");
    this.database().prepare("DELETE FROM agent_sessions WHERE id = ? AND deleted_at IS NOT NULL").run(id);
    this.nextEventIndex.delete(id);
  }

  events(id: string): AgentSessionEvent[] {
    this.get(id);
    return this.database().prepare("SELECT payload FROM agent_events WHERE session_id = ? ORDER BY event_index")
      .all(id).map((row) => JSON.parse(String(row.payload)) as AgentSessionEvent);
  }

  append(id: string, event: RunEvent): AgentSessionEvent {
    const record = this.get(id);
    let eventIndex = this.nextEventIndex.get(id);
    if (eventIndex === undefined) {
      const row = this.database().prepare("SELECT COALESCE(MAX(event_index), 0) AS last_index FROM agent_events WHERE session_id = ?").get(id);
      eventIndex = Number(row?.last_index ?? 0) + 1;
    }
    const entry: AgentSessionEvent = { ...event, sessionId: id, eventIndex };
    const next = { ...record };
    if (entry.kind === "user" && next.title === "新会话" && entry.text?.trim()) {
      next.title = entry.text.trim().replace(/\s+/gu, " ").slice(0, 55);
    }
    if (entry.kind === "user") next.lastPromptAt = entry.at;
    if (entry.phase) {
      next.phase = entry.phase;
      next.statusText = entry.text ?? entry.phase;
    }
    if (entry.kind === "error") {
      next.phase = "error";
      next.statusText = entry.text ?? "运行出错";
    }
    if (entry.kind === "user" || entry.phase || entry.kind === "error") next.updatedAt = entry.at;
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO agent_events (session_id, event_index, payload) VALUES (?, ?, ?)")
        .run(id, eventIndex, JSON.stringify(entry));
      if (entry.kind === "user" || entry.phase || entry.kind === "error") {
        db.prepare("UPDATE agent_sessions SET title = ?, updated_at = ?, last_prompt_at = ?, phase = ?, status_text = ? WHERE id = ?")
          .run(next.title, next.updatedAt, next.lastPromptAt, next.phase, next.statusText, id);
      }
      db.exec("COMMIT");
      this.nextEventIndex.set(id, eventIndex + 1);
      return entry;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private database(): DatabaseSync {
    if (!this.db) throw new Error("会话数据库尚未启动");
    return this.db;
  }
}
