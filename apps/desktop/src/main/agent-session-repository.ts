import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRuntimeId, AgentSessionEvent, AgentSessionSummary, RunEvent, RuntimePhase } from "../../../../packages/contracts/src/index";

export interface StoredAgentSession extends AgentSessionSummary {
  nativeRef: string | null;
}

const runtimeIds = new Set<AgentRuntimeId>(["dsh", "codex", "pi", "kimi-code"]);

function summary(record: StoredAgentSession): AgentSessionSummary {
  const { nativeRef: _nativeRef, ...visible } = record;
  return visible;
}

function fromRow(row: Record<string, unknown>): StoredAgentSession {
  return {
    id: String(row.id), runtimeId: String(row.runtime_id) as AgentRuntimeId,
    workspace: String(row.workspace), title: String(row.title),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    phase: String(row.phase) as RuntimePhase, statusText: String(row.status_text),
    nativeRef: row.native_ref === null ? null : String(row.native_ref),
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
        native_ref TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_events (
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        event_index INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, event_index)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_sessions_runtime ON agent_sessions(runtime_id, created_at DESC);
    `);
    db.prepare("UPDATE agent_sessions SET phase = 'idle', status_text = '上次运行已中断，可继续会话' WHERE phase IN ('starting', 'running', 'approval', 'cancelling')").run();
  }

  close(): void { this.db?.close(); this.db = null; }

  list(runtimeId: AgentRuntimeId): AgentSessionSummary[] {
    return this.database().prepare("SELECT * FROM agent_sessions WHERE runtime_id = ? ORDER BY created_at DESC")
      .all(runtimeId).map((row) => summary(fromRow(row)));
  }

  get(id: string): StoredAgentSession {
    const row = this.database().prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id);
    if (!row) throw new Error("会话不存在或已删除");
    return fromRow(row);
  }

  create(runtimeId: AgentRuntimeId, workspace: string): AgentSessionSummary {
    if (!runtimeIds.has(runtimeId)) throw new Error("此运行时暂不支持会话");
    const now = new Date().toISOString();
    const record: StoredAgentSession = {
      id: randomUUID(), runtimeId, workspace, title: "新会话", createdAt: now, updatedAt: now,
      phase: "idle", statusText: "尚未连接", nativeRef: null,
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
        db.prepare("UPDATE agent_sessions SET title = ?, updated_at = ?, phase = ?, status_text = ? WHERE id = ?")
          .run(next.title, next.updatedAt, next.phase, next.statusText, id);
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
