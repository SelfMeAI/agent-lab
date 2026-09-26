import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../../../../packages/contracts/src/index";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function event(kind: RunEvent["kind"], text: string, phase?: RunEvent["phase"]): RunEvent {
  return { runtimeId: "pi", runId: "run-1", sequence: 1, at: new Date().toISOString(), source: "Pi", kind, text, phase };
}

describe("agent session SQLite storage", () => {
  it("recovers pending steering without resending it and preserves confirmed receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-steering-recovery-"));
    roots.push(root);
    const first = new AgentSessionRepository(root);
    await first.init();
    const session = first.create("pi", root);
    first.append(session.id, event("user", "original"));
    first.append(session.id, event("status", "working", "running"));
    for (const messageId of ["pending", "confirmed"]) first.append(session.id, {
      ...event("user", "supplement"), messageId, deliveryMode: "steer", deliveryState: "submitting",
    });
    first.append(session.id, { ...event("delivery", "accepted"), messageId: "pending", deliveryState: "queued" });
    first.append(session.id, { ...event("delivery", "incorporated"), messageId: "confirmed", deliveryState: "incorporated" });
    first.close();
    const reopened = new AgentSessionRepository(root);
    await reopened.init();
    expect(reopened.get(session.id).phase).toBe("idle");
    const receipts = reopened.events(session.id).filter(e => e.kind === "delivery");
    expect(receipts.filter(e => e.messageId === "pending").at(-1)?.deliveryState).toBe("unconfirmed");
    expect(receipts.filter(e => e.messageId === "confirmed")).toHaveLength(1);
    const count = reopened.events(session.id).length;
    reopened.close();
    const twice = new AgentSessionRepository(root);
    await twice.init();
    expect(twice.events(session.id)).toHaveLength(count);
    twice.close();
  });

  it("keeps sessions, native references, and independent event streams across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-sessions-"));
    roots.push(root);
    const first = new AgentSessionRepository(root);
    await first.init();
    const a = first.create("pi", root);
    const b = first.create("pi", root);
    first.setNativeRef(a.id, join(root, "pi-session.jsonl"));
    first.append(a.id, event("user", "请检查这个项目"));
    first.append(a.id, event("status", "正在执行", "running"));
    first.append(a.id, event("message", "已检查"));
    first.append(b.id, event("user", "另一个实验"));
    first.close();

    const reopened = new AgentSessionRepository(root);
    await reopened.init();
    expect(reopened.get(a.id)).toMatchObject({ nativeRef: join(root, "pi-session.jsonl"), title: "请检查这个项目", phase: "idle" });
    expect(reopened.get(a.id).statusText).toContain("中断");
    expect(reopened.events(a.id).map((entry) => entry.kind)).toEqual(["user", "status", "message"]);
    expect(reopened.events(b.id).map((entry) => entry.text)).toEqual(["另一个实验"]);
    expect(reopened.list("pi").map((entry) => entry.id)).toEqual([b.id, a.id]);
    expect(reopened.list("pi").find((entry) => entry.id === a.id)?.lastActivityAt).toBe(reopened.events(a.id).at(-1)?.at);
    reopened.close();
  });

  it("stores UI selection in a separate config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-config-"));
    roots.push(root);
    const first = new AppConfigStore(root);
    await first.init();
    await first.select("dsh", "session-a", root);
    const reopened = new AppConfigStore(root);
    await reopened.init();
    expect(reopened.get("dsh")).toEqual({ selectedSessionId: "session-a", lastWorkspace: root });
    expect(reopened.get("pi")).toEqual({ selectedSessionId: null, lastWorkspace: null });
  });

  it("keeps the last selection when config writes overlap", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-config-overlap-"));
    roots.push(root);
    const config = new AppConfigStore(root);
    await config.init();
    await Promise.all([
      config.select("dsh", "first", root),
      config.select("pi", "second", root),
      config.select("dsh", "third", root),
    ]);
    const reopened = new AppConfigStore(root);
    await reopened.init();
    expect(reopened.get("dsh").selectedSessionId).toBe("third");
    expect(reopened.get("pi").selectedSessionId).toBe("second");
  });

  it("sorts by the last user task, not later runtime status, and keeps deletion recoverable", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-session-order-"));
    roots.push(root);
    const repo = new AgentSessionRepository(root);
    await repo.init();
    const first = repo.create("pi", root);
    const second = repo.create("pi", root);
    repo.append(first.id, { ...event("user", "first task"), at: "2026-09-26T09:00:00.000Z" });
    repo.append(second.id, { ...event("user", "second task"), at: "2026-09-26T10:00:00.000Z" });
    repo.append(first.id, { ...event("status", "finished", "ready"), at: "2026-09-26T11:00:00.000Z" });
    expect(repo.list("pi").map((item) => item.id)).toEqual([second.id, first.id]);
    expect(repo.list("pi").find((item) => item.id === first.id)?.lastActivityAt).toBe("2026-09-26T09:00:00.000Z");
    expect(repo.get(first.id).lastPromptAt).toBe("2026-09-26T09:00:00.000Z");
    repo.softDelete(second.id);
    expect(repo.list("pi").map((item) => item.id)).toEqual([first.id]);
    expect(repo.listDeleted("pi").map((item) => item.id)).toEqual([second.id]);
    expect(() => repo.get(second.id)).toThrow("最近删除");
    expect(() => repo.events(second.id)).toThrow("最近删除");
    repo.restore(second.id);
    expect(repo.list("pi").map((item) => item.id)).toEqual([second.id, first.id]);
    repo.softDelete(second.id);
    repo.purge(second.id);
    expect(repo.listDeleted("pi")).toEqual([]);
    expect(() => repo.get(second.id, true)).toThrow("不存在");
    repo.close();
  });

  it("migrates an existing SQLite file and recovers last prompt time from history", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-session-migration-"));
    roots.push(root);
    const old = new DatabaseSync(join(root, "agent-sessions.sqlite"));
    old.exec(`
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, workspace TEXT NOT NULL,
        title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        phase TEXT NOT NULL, status_text TEXT NOT NULL, native_ref TEXT
      ) STRICT;
      CREATE TABLE agent_events (
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        event_index INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (session_id, event_index)
      ) STRICT;
    `);
    old.prepare("INSERT INTO agent_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("old-session", "pi", root, "Legacy", "2026-09-20T00:00:00Z", "2026-09-25T18:00:00Z", "ready", "已就绪", null);
    old.prepare("INSERT INTO agent_events VALUES (?, ?, ?)").run("old-session", 1,
      JSON.stringify({ ...event("user", "old task"), at: "2026-09-22T12:00:00Z" }));
    old.close();
    const repo = new AgentSessionRepository(root);
    await repo.init();
    expect(repo.list("pi")[0]).toMatchObject({ id: "old-session", lastPromptAt: "2026-09-22T12:00:00Z" });
    repo.softDelete("old-session");
    expect(repo.listDeleted("pi")).toHaveLength(1);
    repo.close();
  });

  it("lists a large set without truncation and keeps recent work at the front", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-session-many-"));
    roots.push(root);
    const repo = new AgentSessionRepository(root);
    await repo.init();
    const sessions = Array.from({ length: 160 }, () => repo.create("dsh", root));
    expect(repo.list("dsh")).toHaveLength(160);
    repo.append(sessions[0].id, { ...event("user", "older session, new work"), runtimeId: "dsh", at: "2026-09-26T23:00:00Z" });
    expect(repo.list("dsh")[0].id).toBe(sessions[0].id);
    repo.close();
  });

});
