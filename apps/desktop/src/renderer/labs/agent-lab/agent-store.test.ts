import { describe, expect, it } from "vitest";
import type { AgentSessionEvent, AgentSessionSummary } from "../../../../../../packages/contracts/src/index";
import { createAgentStore } from "./agent-store";
import { presentEntry } from "./tool-presentation";

const session = (id: string): AgentSessionSummary => ({
  id, runtimeId: "dsh", workspace: "/tmp/example", title: "新会话",
  createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z", phase: "ready", statusText: "已就绪",
});

function event(sessionId: string, eventIndex: number, extra: Partial<AgentSessionEvent>): AgentSessionEvent {
  return {
    sessionId, eventIndex, runtimeId: "dsh", runId: "test-run", sequence: eventIndex,
    at: "2026-09-25T00:00:00Z", source: "DSH", kind: "tool", ...extra,
  };
}

describe("agent transcript updates", () => {
  it("keeps ACP tool metadata when later updates contain a diff", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [session("a")], selectedSessionId: "a", lastWorkspace: "/tmp/example" });
    store.ingest(event("a", 1, { toolCallId: "edit-1", title: "edit", toolStatus: "in_progress", raw: { kind: "edit", locations: [{ path: "src/a.ts" }] } }));
    store.ingest(event("a", 2, { toolCallId: "edit-1", toolStatus: "completed", raw: { content: [{ type: "diff", path: "src/a.ts", oldText: "old\n", newText: "new\n" }] } }));
    const entries = store.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(presentEntry(entries[0])).toMatchObject({ label: "编辑文件", summary: "1 个文件 · +1 −1", status: "已完成" });
  });

  it("omits empty ACP usage updates from the conversation", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [session("a")], selectedSessionId: "a", lastWorkspace: null });
    store.ingest(event("a", 1, { kind: "status", raw: { sessionUpdate: "usage_update" } }));
    expect(store.getSnapshot().entries).toHaveLength(0);
  });

  it("keeps two sessions separate and merges saved history with live updates", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [session("b"), session("a")], selectedSessionId: "a", lastWorkspace: null });
    store.ingest(event("a", 2, { kind: "message", text: "after " }));
    store.loadHistory("a", [event("a", 1, { kind: "user", text: "first" })]);
    expect(store.getSnapshot().entries.map((entry) => entry.text)).toEqual(["first", "after "]);
    store.select("b");
    store.ingest(event("b", 1, { kind: "user", text: "second" }));
    expect(store.getSnapshot().entries.map((entry) => entry.text)).toEqual(["second"]);
    store.select("a");
    expect(store.getSnapshot().entries.map((entry) => entry.text)).toEqual(["first", "after "]);
  });
});
