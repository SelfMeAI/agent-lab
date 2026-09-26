import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRuntimeId, AgentSessionEvent, AgentSessionSummary, AgentSessionQueue, FollowUpMode, PendingAgentMessage, RunEvent, RuntimePhase } from "../../../../packages/contracts/src/index";
import { agentRuntimeIds } from "../../../../packages/contracts/src/index";

export interface StoredAgentSession extends AgentSessionSummary {
  nativeRef: string | null;
  deletedAt: string | null;
}

const runtimeIds = new Set<AgentRuntimeId>(agentRuntimeIds);
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
    followUpMode: row.follow_up_mode === "steer" ? "steer" : "queue",
    nativeRef: row.native_ref === null ? null : String(row.native_ref),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

/** App-owned session index and transcript. Harness-native context stays in each runtime home. */
export class AgentSessionRepository {
  private db: DatabaseSync | null = null;
  private readonly nextEventIndex = new Map<string, number>();

  constructor(private readonly root: string) {}

  async init(legacyFollowUpMode: FollowUpMode = "queue"): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, "agent-sessions.sqlite");
    const db = new DatabaseSync(path, { timeout: 3000 });
    this.db = db;
    await chmod(path, 0o600);
    const hadQueue = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_pending_messages'").get();
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
      CREATE TABLE IF NOT EXISTS agent_pending_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        position INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('queue', 'steer')),
        state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'awaiting', 'unconfirmed')),
        detail TEXT
      ) STRICT;
    `);
    const columns = new Set(db.prepare("PRAGMA table_info(agent_sessions)").all().map((row) => String(row.name)));
    if (!columns.has("last_prompt_at")) db.exec("ALTER TABLE agent_sessions ADD COLUMN last_prompt_at TEXT");
    if (!columns.has("deleted_at")) db.exec("ALTER TABLE agent_sessions ADD COLUMN deleted_at TEXT");
    if (!columns.has("queue_paused")) db.exec("ALTER TABLE agent_sessions ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("follow_up_mode")) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("ALTER TABLE agent_sessions ADD COLUMN follow_up_mode TEXT NOT NULL DEFAULT 'queue' CHECK (follow_up_mode IN ('queue', 'steer'))");
        // Import once for existing (including deleted) sessions. New ones keep
        // the Queue default; a later restart cannot overwrite independent choices.
        if (legacyFollowUpMode === "steer") db.exec("UPDATE agent_sessions SET follow_up_mode = 'steer'");
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    db.exec("CREATE INDEX IF NOT EXISTS agent_pending_order ON agent_pending_messages(session_id, position)");
    // Never start saved work on app launch. In-flight handoffs are uncertain,
    // while unsent queue entries remain safely editable after recovery.
    db.prepare("UPDATE agent_pending_messages SET state = 'unconfirmed', detail = '上次发送未确认，请查看对话后决定是否重发' WHERE state IN ('sending', 'awaiting')").run();
    db.prepare("UPDATE agent_sessions SET queue_paused = 1 WHERE EXISTS (SELECT 1 FROM agent_pending_messages p WHERE p.session_id = agent_sessions.id)").run();
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
      WHERE json_extract(u.payload, '$.kind') = 'user'
      AND json_extract(u.payload, '$.deliveryMode') = 'steer'
      AND NOT EXISTS (SELECT 1 FROM agent_events d WHERE d.session_id = u.session_id
        AND json_extract(d.payload, '$.kind') = 'delivery'
        AND json_extract(d.payload, '$.messageId') = json_extract(u.payload, '$.messageId')
        AND json_extract(d.payload, '$.deliveryState') IN (${hadQueue ? "'incorporated', 'unconfirmed', 'rejected'" : "'incorporated'"}))
      AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = u.session_id AND s.deleted_at IS NULL)`).all();
    for (const row of pending) {
      const event = JSON.parse(String(row.payload)) as AgentSessionEvent;
      if (event.messageId && !this.queueMessage(event.sessionId, event.messageId)) {
        this.addQueueMessage(event.sessionId, { id: event.messageId, text: event.text ?? "", createdAt: event.at, mode: "steer", state: "unconfirmed", detail: "上次发送未确认，请查看对话后决定是否重发" }, true);
        this.pauseQueue(event.sessionId, true);
      }
      this.append(event.sessionId, { runtimeId: event.runtimeId, runId: event.runId, sequence: 0, at: new Date().toISOString(), source: "SelfMe Lab",
        kind: "delivery", messageId: event.messageId, deliveryState: "unconfirmed", text: "上次连接已中断，未确认接入；不会自动重发" });
    }
  }

  close(): void { this.db?.close(); this.db = null; }

  queue(id: string): AgentSessionQueue {
    this.get(id);
    const row = this.database().prepare("SELECT queue_paused FROM agent_sessions WHERE id = ?").get(id)!;
    const messages = this.database().prepare("SELECT * FROM agent_pending_messages WHERE session_id = ? ORDER BY position, rowid").all(id)
      .map((item): PendingAgentMessage => ({ id: String(item.id), text: String(item.text), createdAt: String(item.created_at), mode: String(item.mode) as PendingAgentMessage["mode"],
        state: String(item.state) as PendingAgentMessage["state"], ...(item.detail == null ? {} : { detail: String(item.detail) }) }));
    return { messages, paused: Boolean(row.queue_paused) };
  }

  queueMessage(id: string, messageId: string): PendingAgentMessage | undefined {
    return this.queue(id).messages.find((item) => item.id === messageId);
  }

  addQueueMessage(id: string, message: PendingAgentMessage, recovering = false): void {
    this.get(id);
    if (!recovering && this.queue(id).messages.length >= 10) throw new Error("已有 10 条消息待发送，请先处理队列");
    this.database().prepare(`INSERT INTO agent_pending_messages (id, session_id, text, created_at, position, mode, state, detail)
      VALUES (?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM agent_pending_messages WHERE session_id = ?), 0), ?, ?, ?)`)
      .run(message.id, id, message.text, message.createdAt, id, message.mode, message.state, message.detail ?? null);
  }

  updateQueueMessage(id: string, messageId: string, patch: Partial<Pick<PendingAgentMessage, "text" | "state" | "mode" | "detail">>): void {
    const item = this.queueMessage(id, messageId);
    if (!item) throw new Error("消息已发送或已删除");
    const next = { ...item, ...patch };
    this.database().prepare("UPDATE agent_pending_messages SET text = ?, state = ?, mode = ?, detail = ? WHERE session_id = ? AND id = ?")
      .run(next.text, next.state, next.mode, next.detail ?? null, id, messageId);
  }

  removeQueueMessage(id: string, messageId: string): void {
    this.get(id);
    this.database().prepare("DELETE FROM agent_pending_messages WHERE session_id = ? AND id = ?").run(id, messageId);
  }

  moveQueueMessage(id: string, messageId: string, direction: "up" | "down"): void {
    this.get(id);
    if (direction !== "up" && direction !== "down") throw new Error("排序方向无效");
    const rows = this.database().prepare("SELECT id, position, state FROM agent_pending_messages WHERE session_id = ? AND state != 'awaiting' ORDER BY position, rowid").all(id);
    const index = rows.findIndex((item) => item.id === messageId), other = rows[index + (direction === "up" ? -1 : 1)];
    if (index < 0) throw new Error("消息已发送或已删除");
    if (!other) return;
    if (rows[index].state !== "queued" || other.state !== "queued") throw new Error("提交中的消息不能调整顺序");
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const update = db.prepare("UPDATE agent_pending_messages SET position = ? WHERE session_id = ? AND id = ?");
      update.run(other.position as number, id, messageId);
      update.run(rows[index].position as number, id, String(other.id));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  pauseQueue(id: string, paused: boolean): void {
    this.get(id);
    this.database().prepare("UPDATE agent_sessions SET queue_paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
  }

  retryQueueMessage(id: string, messageId: string): void {
    const item = this.queueMessage(id, messageId);
    if (!item || item.state !== "unconfirmed") throw new Error("消息不需要重新发送");
    // Replace the identity in place, atomically. Late receipts from the old
    // handoff cannot acknowledge the retry, and its queue order is preserved.
    this.database().prepare("UPDATE agent_pending_messages SET id = ?, mode = 'queue', state = 'queued', detail = NULL WHERE session_id = ? AND id = ?")
      .run(randomUUID(), id, messageId);
    this.pauseQueue(id, true);
  }

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

  setFollowUpMode(id: string, mode: FollowUpMode): void {
    this.get(id);
    if (mode !== "queue" && mode !== "steer") throw new Error("发送模式无效");
    this.database().prepare("UPDATE agent_sessions SET follow_up_mode = ? WHERE id = ?").run(mode, id);
  }

  create(runtimeId: AgentRuntimeId, workspace: string): AgentSessionSummary {
    if (!runtimeIds.has(runtimeId)) throw new Error("此运行时暂不支持会话");
    const now = new Date().toISOString();
    const record: StoredAgentSession = {
      id: randomUUID(), runtimeId, workspace, title: "新会话", createdAt: now, updatedAt: now,
      phase: "idle", statusText: "尚未连接", nativeRef: null,
      followUpMode: "queue",
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
      // Receipt + queue admission are a single durable decision. A crash cannot
      // resurrect an acknowledged item or reuse a rejected handoff identity.
      if (entry.kind === "delivery" && entry.messageId) {
        if (entry.deliveryState === "incorporated") db.prepare("DELETE FROM agent_pending_messages WHERE session_id = ? AND id = ?").run(id, entry.messageId);
        else if (entry.deliveryState === "queued") db.prepare("UPDATE agent_pending_messages SET state = 'awaiting' WHERE session_id = ? AND id = ? AND state = 'sending'").run(id, entry.messageId);
        else if (entry.deliveryState === "rejected" || entry.deliveryState === "unconfirmed") {
          db.prepare("UPDATE agent_pending_messages SET id = ?, state = ?, mode = 'queue', detail = ? WHERE session_id = ? AND id = ?")
            .run(entry.deliveryState === "rejected" ? randomUUID() : entry.messageId, entry.deliveryState === "rejected" ? "queued" : "unconfirmed", entry.text ?? null, id, entry.messageId);
          db.prepare("UPDATE agent_sessions SET queue_paused = 1 WHERE id = ?").run(id);
        }
      }
      if (entry.kind === "error" || entry.phase === "error" || entry.phase === "cancelling") db.prepare("UPDATE agent_sessions SET queue_paused = 1 WHERE id = ?").run(id);
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
