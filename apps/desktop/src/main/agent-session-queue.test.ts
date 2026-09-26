import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeId, AgentSessionEvent, AgentSessionQueue, RunEvent } from "../../../../packages/contracts/src/index";
import type { HarnessAdapter } from "../../../../packages/runtime/src/index";
import { AgentSessionController } from "./agent-session-controller";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";
import { createAgentStore, isTranscriptInput } from "../renderer/labs/agent-lab/agent-store";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class QueueAdapter implements HarnessAdapter {
  readonly id: AgentRuntimeId = "pi";
  readonly label = "Queue test";
  readonly prompts: string[] = [];
  readonly supplements: Array<{ text: string; messageId: string }> = [];
  readonly listeners = new Set<(event: RunEvent) => void>();
  failSend = false;
  rejectSteer = false;
  constructor(private readonly sessionId: string) {}
  probe = async () => ({ id: this.id, label: this.label, availability: "ready" as const });
  getResumeRef = () => `native-${this.sessionId}`;
  onEvent = (listener: (event: RunEvent) => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  emit(patch: Partial<RunEvent>): void {
    const event: RunEvent = { runtimeId: this.id, runId: `run-${this.prompts.length}`, sequence: 0, source: this.label, at: new Date().toISOString(), kind: "status", ...patch };
    for (const listener of this.listeners) listener(event);
  }
  start = async () => { this.emit({ phase: "ready" }); };
  send = async (text: string) => {
    if (this.failSend) throw new Error("transport failed after handoff");
    this.prompts.push(text); this.emit({ phase: "running" });
  };
  steer = async (text: string, messageId: string) => {
    if (this.rejectSteer) throw new Error("本轮已结束");
    this.supplements.push({ text, messageId }); this.emit({ kind: "delivery", messageId, deliveryState: "queued" });
  };
  cancel = async () => { this.emit({ phase: "ready", text: "已取消" }); };
  stop = async () => { this.emit({ phase: "idle" }); };
  respondApproval = async () => {};
  complete = () => this.emit({ phase: "ready" });
}

async function fixture() {
  const scratchRoot = fileURLToPath(new URL("../../../../.work/", import.meta.url));
  await mkdir(scratchRoot, { recursive: true });
  const root = await mkdtemp(join(scratchRoot, "queue-unit-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repository = new AgentSessionRepository(root); await repository.init();
  cleanups.push(async () => repository.close());
  const config = new AppConfigStore(root); await config.init();
  const adapters = new Map<string, QueueAdapter>();
  const events: AgentSessionEvent[] = [], changes: AgentSessionQueue[] = [];
  const controller = new AgentSessionController(repository, config, (_runtime, id) => {
    const adapter = new QueueAdapter(id); adapters.set(id, adapter); return adapter;
  }, event => events.push(event), false, undefined, (_id, queue) => changes.push(queue));
  cleanups.push(() => controller.stopAll());
  const session = await controller.create("pi", root);
  await controller.send(session.id, "original");
  return { root, repository, config, controller, session, adapter: adapters.get(session.id)!, events, changes };
}

describe("durable follow-up queue and native steering", () => {
  it("waits for native turn end (not a tool end), dispatches FIFO once, and edits/reorders/removes safely", async () => {
    const { controller: c, repository: r, session: s, adapter: a } = await fixture();
    await c.enqueue(s.id, "first"); await c.enqueue(s.id, "second"); await c.enqueue(s.id, "remove");
    const [first, second, remove] = r.queue(s.id).messages;
    await c.editQueued(s.id, first.id, "first edited"); await c.moveQueued(s.id, second.id, "up"); await c.deleteQueued(s.id, remove.id);
    a.emit({ kind: "tool", toolCallId: "tool", toolStatus: "completed", text: "done" });
    await Promise.resolve(); expect(a.prompts).toEqual(["original"]);
    a.complete(); await vi.waitFor(() => expect(a.prompts).toEqual(["original", "second"]));
    expect(r.queue(s.id).messages.map(item => item.text)).toEqual(["first edited"]);
    a.complete(); await vi.waitFor(() => expect(a.prompts).toEqual(["original", "second", "first edited"]));
    expect(r.queue(s.id).messages).toEqual([]);
    a.complete(); await Promise.resolve(); expect(a.prompts).toHaveLength(3);
  });

  it("Steer promotes just the chosen queue item into the existing run, with no next-turn fallback", async () => {
    const { controller: c, repository: r, session: s, adapter: a, events } = await fixture();
    await c.enqueue(s.id, "keep queued"); await c.enqueue(s.id, "mid-turn");
    const item = r.queue(s.id).messages[1];
    await c.steerQueued(s.id, item.id);
    expect(a.prompts).toEqual(["original"]);
    expect(a.supplements).toEqual([{ text: "mid-turn", messageId: item.id }]);
    expect(r.queueMessage(s.id, item.id)?.state).toBe("awaiting");
    a.emit({ kind: "delivery", messageId: item.id, deliveryState: "incorporated" });
    expect(r.queue(s.id).messages.map(row => row.text)).toEqual(["keep queued"]);
    expect(events.find(event => event.deliveryMode === "steer")).toMatchObject({ runId: "run-1", text: "mid-turn" });
    c.pauseQueue(s.id); a.complete();
    await expect(c.steerQueued(s.id, r.queue(s.id).messages[0].id)).rejects.toThrow(/结束/);
    expect(a.prompts).toHaveLength(1);
  });

  it("cancellation pauses before an immediate ready event; resume is explicit", async () => {
    const { controller: c, repository: r, session: s, adapter: a } = await fixture();
    await c.enqueue(s.id, "retained"); await c.cancel(s.id);
    await Promise.resolve(); expect(a.prompts).toEqual(["original"]);
    expect(r.queue(s.id).paused).toBe(true);
    await c.resumeQueue(s.id); await vi.waitFor(() => expect(a.prompts).toEqual(["original", "retained"]));
  });

  it("pauses on task error even if a ready event follows; does not bypass a saved backlog", async () => {
    const { controller: c, repository: r, session: s, adapter: a } = await fixture();
    await c.enqueue(s.id, "retained"); a.emit({ kind: "error", text: "failed" }); a.complete();
    await Promise.resolve(); expect(a.prompts).toHaveLength(1);
    expect(r.queue(s.id).paused).toBe(true);
    await expect(c.send(s.id, "bypass")).rejects.toThrow(/队列/);
    await c.resumeQueue(s.id); await vi.waitFor(() => expect(a.prompts).toHaveLength(2));
  });

  it("a failed handoff is never auto-retried, and retry uses a fresh identity in the same position", async () => {
    const { controller: c, repository: r, session: s, adapter: a } = await fixture();
    await c.enqueue(s.id, "uncertain"); await c.enqueue(s.id, "later");
    const oldId = r.queue(s.id).messages[0].id;
    a.failSend = true; a.complete();
    await vi.waitFor(() => expect(r.queue(s.id).messages[0].state).toBe("unconfirmed"));
    await expect(c.resumeQueue(s.id)).rejects.toThrow(/未确认/);
    await c.retryQueued(s.id, oldId);
    const retry = r.queue(s.id).messages[0];
    expect(retry.id).not.toBe(oldId); expect(retry.text).toBe("uncertain");
    a.emit({ kind: "delivery", messageId: oldId, deliveryState: "incorporated" });
    expect(r.queueMessage(s.id, retry.id)).toBeDefined();
    a.failSend = false; await c.resumeQueue(s.id);
    await vi.waitFor(() => expect(a.prompts).toEqual(["original", "uncertain"]));
    expect(r.queue(s.id).messages.map(item => item.text)).toEqual(["later"]);
  });

  it("a rejected Steer is safely returned to the queue without duplicating its transcript on retry", async () => {
    const { controller: c, repository: r, session: s, adapter: a, events } = await fixture();
    await c.enqueue(s.id, "supplement"); const originalId = r.queue(s.id).messages[0].id;
    a.rejectSteer = true; await c.steerQueued(s.id, originalId);
    const next = r.queue(s.id).messages[0];
    expect(next.id).not.toBe(originalId); expect(next.state).toBe("queued"); expect(r.queue(s.id).paused).toBe(true);
    a.rejectSteer = false; await c.steerQueued(s.id, next.id);
    a.emit({ kind: "delivery", messageId: next.id, deliveryState: "incorporated" });
    const store = createAgentStore("pi"); store.setCatalog(c.catalog("pi")); store.loadHistory(s.id, events);
    expect(store.getSnapshot().entries.filter(isTranscriptInput).filter(item => item.text === "supplement")).toHaveLength(1);
  });

  it("enforces a combined limit and blocks withdrawal of native-admitted inputs", async () => {
    const { controller: c, repository: r, session: s } = await fixture();
    await c.steer(s.id, "admitted"); const id = r.queue(s.id).messages[0].id;
    await expect(c.deleteQueued(s.id, id)).rejects.toThrow(/撤回/);
    await expect(c.editQueued(s.id, id, "change")).rejects.toThrow(/编辑/);
    for (let i = 0; i < 9; i++) await c.enqueue(s.id, `queued ${i}`);
    await expect(c.enqueue(s.id, "too many")).rejects.toThrow(/10/);
    expect(r.queue(s.id).messages).toHaveLength(10);
  });

  it("keeps editing paused across completion and isolates queue contents per session", async () => {
    const { controller: c, repository: r, session: s, adapter: a } = await fixture();
    await c.enqueue(s.id, "editing"); c.pauseQueue(s.id); a.complete();
    const id = r.queue(s.id).messages[0].id; await c.editQueued(s.id, id, "saved edit");
    expect(a.prompts).toHaveLength(1);
    const other = await c.create("pi", s.workspace); await c.activate(other.id);
    expect(c.catalog("pi").queues?.[other.id].messages).toEqual([]);
    expect(r.queue(s.id).messages[0].text).toBe("saved edit");
    await c.activate(s.id); expect(r.queue(s.id).paused).toBe(true);
    await c.resumeQueue(s.id); await vi.waitFor(() => expect(r.queue(s.id).messages).toHaveLength(0));
  });

  it("does not drain a session deleted in the completion/selection race", async () => {
    const { controller: c, repository: r, session: s, adapter: a } = await fixture();
    await c.enqueue(s.id, "saved queue");
    // Deletion is serialized first; ready arrives before that operation runs.
    const deletion = c.delete(s.id); a.complete(); await deletion;
    await Promise.resolve(); expect(a.prompts).toEqual(["original"]);
    expect(c.catalog("pi").sessions).toHaveLength(0);
    await c.restore(s.id); expect(r.queue(s.id)).toMatchObject({ paused: true, messages: [{ text: "saved queue" }] });
  });
});
