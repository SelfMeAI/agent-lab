import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("stores the send preference in the existing config and preserves selections across concurrent writes", async () => {
    const root = await scratch(); const c = new AppConfigStore(root); await c.init(); expect(c.getFollowUpMode()).toBe("queue");
    await Promise.all([c.select("pi", "session", "/workspace"), c.setFollowUpMode("steer"), c.select("dsh", "dsh-session", "/other")]);
    const reopened = new AppConfigStore(root); await reopened.init();
    expect(reopened.getFollowUpMode()).toBe("steer"); expect(reopened.get("pi").selectedSessionId).toBe("session");
    expect(JSON.parse(await readFile(join(root, "app-config.json"), "utf8")).followUpMode).toBe("steer");
    await expect(c.setFollowUpMode("invalid" as "queue")).rejects.toThrow(/无效/);
    // An existing pre-queue config needs no migration file or extra storage.
    await writeFile(join(root, "app-config.json"), JSON.stringify({ version: 1, agentLab: { pi: { selectedSessionId: "old", lastWorkspace: "/old" } } }));
    const legacy = new AppConfigStore(root); await legacy.init(); expect(legacy.getFollowUpMode()).toBe("queue"); expect(legacy.get("pi").lastWorkspace).toBe("/old");
  });
});
