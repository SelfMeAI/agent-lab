import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../../../../../packages/contracts/src/index";
import { agentStores } from "./agent-store";
import { presentEntry } from "./tool-presentation";

function event(sequence: number, extra: Partial<RunEvent>): RunEvent {
  return {
    runtimeId: "dsh", runId: "test-run", sequence, at: "2026-09-25T00:00:00Z",
    source: "DSH", kind: "tool", ...extra,
  };
}

describe("agent transcript updates", () => {
  it("keeps ACP tool metadata when later updates contain a diff", () => {
    const store = agentStores.dsh;
    store.clearTranscript();
    store.ingest(event(1, { toolCallId: "edit-1", title: "edit", toolStatus: "in_progress", raw: { kind: "edit", locations: [{ path: "src/a.ts" }] } }));
    store.ingest(event(2, { toolCallId: "edit-1", toolStatus: "completed", raw: { content: [{ type: "diff", path: "src/a.ts", oldText: "old\n", newText: "new\n" }] } }));
    const entries = store.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(presentEntry(entries[0])).toMatchObject({ label: "编辑文件", summary: "1 个文件 · +1 −1", status: "已完成" });
  });

  it("omits empty ACP usage updates from the conversation", () => {
    const store = agentStores.dsh;
    store.clearTranscript();
    store.ingest(event(1, { kind: "status", raw: { sessionUpdate: "usage_update" } }));
    expect(store.getSnapshot().entries).toHaveLength(0);
  });
});
