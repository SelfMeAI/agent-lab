import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingAgentMessage } from "../../../../packages/contracts/src/index";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function scratch() {
  const scratchRoot = fileURLToPath(new URL("../../../../.work/", import.meta.url));
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "queue-storage-")); roots.push(root); return root;
}
const pending = (id: string, state: PendingAgentMessage["state"] = "queued"): PendingAgentMessage => ({ id, text: id, createdAt: new Date().toISOString(), mode: "queue", state });

describe("queue persistence and configuration", () => {
  it("retains queue order, edits, and unknown handoffs on restart, always paused", async () => {
    const root = await scratch(); const first = new AgentSessionRepository(root); await first.init();
    const s = first.create("pi", root), other = first.create("codex", root);
    first.addQueueMessage(s.id, pending("first")); first.addQueueMessage(s.id, pending("second"));
    first.moveQueueMessage(s.id, "second", "up"); first.updateQueueMessage(s.id, "first", { text: "edited" });
    first.addQueueMessage(s.id, pending("sending", "sending")); first.addQueueMessage(s.id, pending("awaiting", "awaiting"));
    first.addQueueMessage(other.id, pending("isolated")); first.close();
    const reopened = new AgentSessionRepository(root); await reopened.init();
    expect(reopened.queue(s.id)).toMatchObject({ paused: true, messages: [{ id: "second", state: "queued" }, { id: "first", text: "edited", state: "queued" }, { id: "sending", state: "unconfirmed" }, { id: "awaiting", state: "unconfirmed" }] });
    expect(reopened.queue(other.id).messages.map(item => item.text)).toEqual(["isolated"]);
    reopened.removeQueueMessage(s.id, "second"); reopened.close();
    const twice = new AgentSessionRepository(root); await twice.init(); expect(twice.queue(s.id).messages).toHaveLength(3); twice.close();
  });

  it("commits native incorporation with queue removal and purges only the deleted session", async () => {
    const root = await scratch(); const r = new AgentSessionRepository(root); await r.init();
    const s = r.create("pi", root), other = r.create("pi", root);
    r.addQueueMessage(s.id, pending("ack", "sending")); r.addQueueMessage(other.id, pending("other"));
    r.append(s.id, { kind: "delivery", runtimeId: "pi", runId: "run", sequence: 1, source: "test", at: new Date().toISOString(), messageId: "ack", deliveryState: "incorporated" });
    expect(r.queue(s.id).messages).toHaveLength(0);
    r.addQueueMessage(s.id, pending("retained")); r.softDelete(s.id); r.restore(s.id);
    expect(r.queue(s.id).messages[0].text).toBe("retained");
    r.softDelete(s.id); r.purge(s.id); expect(r.queue(other.id).messages[0].text).toBe("other"); r.close();
    const reopened = new AgentSessionRepository(root); await reopened.init(); expect(reopened.list("pi")).toHaveLength(1); reopened.close();
  });

  it("keeps each session's mode in SQLite, including two sessions of the same harness", async () => {
    const root = await scratch(); const r = new AgentSessionRepository(root); await r.init();
    const sessions = [r.create("dsh", root), r.create("dsh", root), r.create("pi", root), r.create("codex", root), r.create("kimi-code", root)];
    expect(sessions.every(s => s.followUpMode === "queue")).toBe(true);
    r.setFollowUpMode(sessions[0].id, "steer");
    expect(r.get(sessions[0].id).followUpMode).toBe("steer");
    for (const s of sessions.slice(1)) expect(r.get(s.id).followUpMode).toBe("queue");
    expect(r.create("dsh", root).followUpMode).toBe("queue");
    expect(() => r.setFollowUpMode(sessions[0].id, "invalid" as "queue")).toThrow(/无效/);
    expect(() => r.setFollowUpMode("missing", "steer")).toThrow(/不存在/);
    r.softDelete(sessions[0].id);
    expect(() => r.setFollowUpMode(sessions[0].id, "queue")).toThrow(/最近删除/);
    r.restore(sessions[0].id); r.close();
    const reopened = new AgentSessionRepository(root); await reopened.init();
    expect(reopened.get(sessions[0].id).followUpMode).toBe("steer");
    for (const s of sessions.slice(1)) expect(reopened.get(s.id).followUpMode).toBe("queue");
    reopened.close();
  });

  it("imports the old global mode once without losing queues, history, native refs or selections", async () => {
    const root = await scratch(); const first = new AgentSessionRepository(root); await first.init();
    const a = first.create("dsh", root), b = first.create("pi", root);
    first.setNativeRef(a.id, "native-session");
    first.append(a.id, { kind: "user", text: "keep history", runtimeId: "dsh", runId: "run", source: "test", sequence: 1, at: new Date().toISOString() });
    first.addQueueMessage(a.id, pending("keep queue")); first.softDelete(b.id); first.close();
    const old = new DatabaseSync(join(root, "agent-sessions.sqlite"));
    old.exec("ALTER TABLE agent_sessions DROP COLUMN follow_up_mode"); old.close();
    await writeFile(join(root, "app-config.json"), JSON.stringify({ version: 1, followUpMode: "steer", agentLab: { dsh: { selectedSessionId: a.id, lastWorkspace: root } } }));
    const config = new AppConfigStore(root); await config.init();
    const migrated = new AgentSessionRepository(root); await migrated.init(config.getLegacyFollowUpMode());
    expect(migrated.get(a.id)).toMatchObject({ followUpMode: "steer", nativeRef: "native-session" });
    expect(migrated.get(b.id, true).followUpMode).toBe("steer");
    expect(migrated.events(a.id)[0].text).toBe("keep history");
    expect(migrated.queue(a.id).messages[0].id).toBe("keep queue");
    expect(migrated.create("dsh", root).followUpMode).toBe("queue");
    migrated.setFollowUpMode(a.id, "queue"); migrated.close();
    // Even if a crash leaves the old config behind, independent modes are not re-imported.
    const retry = new AgentSessionRepository(root); await retry.init(config.getLegacyFollowUpMode());
    expect(retry.get(a.id).followUpMode).toBe("queue"); retry.close();
    await Promise.all([config.clearLegacyFollowUpMode(), config.select("pi", b.id, root)]);
    const reopened = new AppConfigStore(root); await reopened.init();
    expect(reopened.get("dsh").selectedSessionId).toBe(a.id);
    expect(reopened.get("pi").selectedSessionId).toBe(b.id);
    expect(JSON.parse(await readFile(join(root, "app-config.json"), "utf8"))).not.toHaveProperty("followUpMode");
  });

  it("creates clean configuration without a global mode and supports older selection-only files", async () => {
    const root = await scratch(); const config = new AppConfigStore(root); await config.init();
    expect(config.getLegacyFollowUpMode()).toBe("queue");
    expect(JSON.parse(await readFile(join(root, "app-config.json"), "utf8"))).not.toHaveProperty("followUpMode");
    await writeFile(join(root, "app-config.json"), JSON.stringify({ version: 1, agentLab: { pi: { selectedSessionId: "old", lastWorkspace: "/old" } } }));
    const legacy = new AppConfigStore(root); await legacy.init();
    expect(legacy.getLegacyFollowUpMode()).toBe("queue"); expect(legacy.get("pi").lastWorkspace).toBe("/old");
  });
});
