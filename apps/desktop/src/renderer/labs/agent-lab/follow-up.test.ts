import { describe, expect, it } from "vitest";
import type { AgentSessionQueue, AgentSessionSummary, AgentSessionEvent } from "../../../../../../packages/contracts/src/index";
import { composerAction } from "./follow-up";
import { createAgentStore, isTranscriptInput } from "./agent-store";

const queue: AgentSessionQueue = { paused: false, messages: [{ id: "queued", text: "later", createdAt: "2026-09-26T10:00:00Z", mode: "queue", state: "queued" }] };
const empty: AgentSessionQueue = { messages: [], paused: false };
const session: AgentSessionSummary = { id: "session", runtimeId: "pi", workspace: "/workspace", title: "test", createdAt: "2026-09-26T10:00:00Z", updatedAt: "2026-09-26T10:00:00Z", phase: "running", statusText: "工作中", lastPromptAt: null, lastActivityAt: null };

describe("follow-up composer and transcript", () => {
  it("keeps queue and Steer as distinct choices and never bypasses a paused backlog", () => {
    expect(composerAction("running", empty, "queue")).toBe("queue"); expect(composerAction("running", queue, "steer")).toBe("steer");
    expect(composerAction("approval", empty, "steer")).toBe("steer"); expect(composerAction("starting", empty, "steer")).toBe("wait");
    expect(composerAction("cancelling", empty, "queue")).toBe("queue"); expect(composerAction("ready", empty, "steer")).toBe("send");
    expect(composerAction("ready", { ...queue, paused: true }, "steer")).toBe("queue"); expect(composerAction("error", queue, "queue")).toBe("queue");
    expect(composerAction("error", empty, "queue")).toBe("wait");
  });

  it("preserves queue snapshots through history loads and session switches, without resetting a running task", () => {
    const store = createAgentStore("pi"), other = { ...session, id: "other" };
    store.setCatalog({ sessions: [session, other], deletedSessions: [], selectedSessionId: session.id, lastWorkspace: session.workspace, queues: { session: queue, other: empty } });
    let index = 0;
    const event = (patch: Partial<AgentSessionEvent>): AgentSessionEvent => ({ sessionId: session.id, runtimeId: "pi", runId: "run", sequence: 1, eventIndex: ++index, kind: "user", at: "2026-09-26T10:00:00Z", source: "test", ...patch });
    const original = event({ text: "original" }); store.loadHistory(session.id, [original]);
    store.ingest(event({ kind: "tool", toolCallId: "tool", text: "working", toolStatus: "running" }));
    store.ingest(event({ text: "steer", deliveryMode: "steer", deliveryState: "submitting", messageId: "steer" }));
    expect(store.getSnapshot().currentTask).toBe("original"); expect(store.getSnapshot().hasExecutionActivity).toBe(true);
    expect(store.getSnapshot().entries.filter(isTranscriptInput).some(item => item.text === "steer")).toBe(false);
    store.ingest(event({ kind: "delivery", messageId: "steer", deliveryState: "queued" }));
    expect(store.getSnapshot().entries.filter(isTranscriptInput).some(item => item.text === "steer")).toBe(true);
    store.setQueue(session.id, { ...queue, paused: true }); store.loadHistory(session.id, [original]);
    expect(store.getSnapshot().queue.paused).toBe(true); expect(store.getSnapshot().currentTask).toBe("original");
    store.select(other.id); expect(store.getSnapshot().queue).toEqual(empty); store.select(session.id); expect(store.getSnapshot().queue.messages).toHaveLength(1);
  });
});
