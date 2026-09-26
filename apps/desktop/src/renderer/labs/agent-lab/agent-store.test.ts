import { describe, expect, it } from "vitest";
import type { AgentSessionEvent, AgentSessionSummary } from "../../../../../../packages/contracts/src/index";
import { createAgentStore } from "./agent-store";
import { presentEntry } from "./tool-presentation";

const session = (id: string): AgentSessionSummary => ({
  id, runtimeId: "dsh", workspace: "/tmp/example", title: "新会话",
  createdAt: "2026-09-25T00:00:00Z", updatedAt: "2026-09-25T00:00:00Z", lastPromptAt: null, lastActivityAt: null, phase: "ready", statusText: "已就绪", followUpMode: "queue",
});

function event(sessionId: string, eventIndex: number, extra: Partial<AgentSessionEvent>): AgentSessionEvent {
  return {
    sessionId, eventIndex, runtimeId: "dsh", runId: "test-run", sequence: eventIndex,
    at: "2026-09-25T00:00:00Z", source: "DSH", kind: "tool", ...extra,
  };
}

describe("agent transcript updates", () => {
  it("replays answers without reviving old questions, crossing sessions or changing turn timing", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [{ ...session("a"), phase: "approval" }], deletedSessions: [], selectedSessionId: "a", lastWorkspace: null });
    const approval = { requestId: 7, title: "选择", options: [], questions: [{ id: "q", header: "游戏", question: "选择？", options: [], multiSelect: false, allowCustom: true }] };
    const history = [event("a", 1, { kind: "user", text: "任务" }), event("a", 2, { kind: "approval", approval }),
      event("a", 3, { kind: "approval_result", approval, text: "游戏：扫雷" }),
      event("a", 4, { kind: "approval", approval: { ...approval, requestId: 8 } })];
    store.loadHistory("a", history);
    expect(store.getSnapshot().entries.filter(e => e.kind === "approval").map(e => e.approval?.requestId)).toEqual([8]);
    expect(store.getSnapshot().entries.some(e => e.title === "你的回答" && e.text === "游戏：扫雷")).toBe(true);
    expect(store.getSnapshot().currentTask).toBe("任务");
    store.ingest(event("a", 5, { kind: "status", phase: "ready" }));
    expect(store.getSnapshot().entries.some(e => e.kind === "approval")).toBe(false);
  });
  it("keeps background output, approvals and queues isolated, even with matching native ids", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [session("a"), session("b")], deletedSessions: [], selectedSessionId: "a", lastWorkspace: null });
    for (const id of ["a", "b"]) {
      store.ingest(event(id, 1, { kind: "user", text: `${id} 的任务` }));
      store.ingest(event(id, 2, { kind: "status", phase: "running", text: "工作中" }));
      store.ingest(event(id, 3, { kind: "tool", toolCallId: "same-tool", toolStatus: "running", text: `${id} 的工具` }));
      store.ingest(event(id, 4, { kind: "approval", phase: "approval", approval: { requestId: 1, title: id, options: [] } }));
    }
    store.setQueue("b", { paused: false, messages: [{ id: "queued-b", text: "B 的下一轮", createdAt: "2026-09-25T00:00:00Z", mode: "queue", state: "queued" }] });
    store.removeApproval("a", 1);
    store.ingest(event("a", 5, { kind: "status", phase: "ready" }));
    store.select("b");
    expect(store.getSnapshot()).toMatchObject({ phase: "approval", queue: { messages: [{ id: "queued-b" }] } });
    expect(store.getSnapshot().entries.find(e => e.kind === "approval")?.approval?.requestId).toBe(1);
    store.ingest(event("a", 6, { kind: "message", text: "A 在后台完成" }));
    expect(store.getSnapshot().entries.some(e => e.text.includes("A 在后台完成"))).toBe(false);
    store.loadHistory("a", [event("a", 1, { kind: "user", text: "a 的任务" })]);
    expect(store.getSnapshot().selectedSessionId).toBe("b");
    store.select("a");
    expect(store.getSnapshot().entries.at(-1)?.text).toBe("A 在后台完成");
    expect(store.getSnapshot().queue.messages).toHaveLength(0);
  });

  it("does not steal selection when a background catalog refresh completes", () => {
    const store = createAgentStore("dsh");
    const catalog = { sessions: [session("a"), session("b")], deletedSessions: [], selectedSessionId: "a", lastWorkspace: null };
    store.setCatalog(catalog);
    store.select("b");
    store.setCatalog(catalog, true);
    expect(store.getSnapshot().selectedSessionId).toBe("b");
    store.ingest(event("b", 1, { kind: "status", phase: "running" }));
    store.setCatalog({ ...catalog, sessions: [session("a"), { ...session("b"), phase: "idle", statusText: "已停止" }] }, true);
    expect(store.getSnapshot().phase).toBe("idle");
    store.setCatalog({ ...catalog, sessions: [session("a")] }, true);
    expect(store.getSnapshot().selectedSessionId).toBe("a");
  });
  it("keeps mode changes scoped to their session across selection, late saves and other harnesses", () => {
    const store = createAgentStore("dsh"), pi = createAgentStore("pi");
    store.setCatalog({ sessions: [session("a"), session("b")], deletedSessions: [], selectedSessionId: "a", lastWorkspace: null });
    pi.setCatalog({ sessions: [{ ...session("pi"), runtimeId: "pi" }], deletedSessions: [], selectedSessionId: "pi", lastWorkspace: null });
    store.setFollowUpMode("a", "steer"); store.select("b");
    expect(store.getSnapshot().sessions.find(s => s.id === "b")?.followUpMode).toBe("queue");
    store.setFollowUpMode("a", "queue");
    expect(store.getSnapshot().selectedSessionId).toBe("b");
    store.setFollowUpMode("a", "steer"); store.select("a");
    expect(store.getSnapshot().sessions.find(s => s.id === "a")?.followUpMode).toBe("steer");
    expect(pi.getSnapshot().sessions[0].followUpMode).toBe("queue");
    store.addSession(session("new"));
    expect(store.getSnapshot().sessions.find(s => s.id === "new")?.followUpMode).toBe("queue");
  });
  it("keeps original task, approval, tool diff and elapsed time when steering is submitted", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [session("a")], deletedSessions: [], selectedSessionId: "a", lastWorkspace: null });
    store.ingest(event("a", 1, { kind: "user", text: "原任务", at: "2026-09-25T00:00:00Z" }));
    store.ingest(event("a", 2, { kind: "tool", toolCallId: "write", toolStatus: "running", raw: { diff: "+new" } }));
    store.ingest(event("a", 3, { kind: "approval", phase: "approval" }));
    store.ingest(event("a", 4, { kind: "user", text: "补充", deliveryMode: "steer", messageId: "supplement", deliveryState: "submitting", at: "2026-09-25T00:00:30Z" }));
    expect(store.getSnapshot()).toMatchObject({ currentTask: "原任务", phase: "approval", hasExecutionActivity: true });
    store.ingest(event("a", 5, { kind: "delivery", messageId: "supplement", deliveryState: "incorporated" }));
    expect(store.getSnapshot().entries.find(e => e.messageId === "supplement")?.deliveryState).toBe("incorporated");
    expect(store.getSnapshot().entries.find(e => e.toolCallId === "write")?.raw).toEqual({ diff: "+new" });
    store.ingest(event("a", 6, { kind: "status", phase: "ready", at: "2026-09-25T00:01:00Z" }));
    expect(store.getSnapshot().entries.at(-1)).toMatchObject({ kind: "turn_end", startedAt: "2026-09-25T00:00:00Z", hasExecutionActivity: true });
    store.loadHistory("a", []);
    expect(store.getSnapshot().entries.find(e => e.messageId === "supplement")?.deliveryState).toBe("incorporated");
  });

  it("keeps ACP tool metadata when later updates contain a diff", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [session("a")], deletedSessions: [], selectedSessionId: "a", lastWorkspace: "/tmp/example" });
    store.ingest(event("a", 1, { toolCallId: "edit-1", title: "edit", toolStatus: "in_progress", raw: { kind: "edit", locations: [{ path: "src/a.ts" }] } }));
    store.ingest(event("a", 2, { toolCallId: "edit-1", toolStatus: "completed", at: "2026-09-25T00:00:02Z", raw: { content: [{ type: "diff", path: "src/a.ts", oldText: "old\n", newText: "new\n" }] } }));
    const entries = store.getSnapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ at: "2026-09-25T00:00:00Z", finishedAt: "2026-09-25T00:00:02Z" });
    expect(presentEntry(entries[0])).toMatchObject({ label: "编辑文件", summary: "1 个文件 · +1 −1", status: "已完成" });
  });

  it("omits empty ACP usage updates from the conversation", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [session("a")], deletedSessions: [], selectedSessionId: "a", lastWorkspace: null });
    store.ingest(event("a", 1, { kind: "status", raw: { sessionUpdate: "usage_update" } }));
    expect(store.getSnapshot().entries).toHaveLength(0);
  });

  it("reconstructs one completed turn from persisted status events, including approval wait", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [session("a")], deletedSessions: [], selectedSessionId: "a", lastWorkspace: null });
    const history = [
      event("a", 1, { kind: "status", phase: "ready", at: "2026-09-25T00:00:00Z" }),
      event("a", 2, { kind: "user", text: "检查项目", at: "2026-09-25T00:01:00Z" }),
      event("a", 3, { kind: "status", phase: "running", at: "2026-09-25T00:01:01Z" }),
      event("a", 4, { kind: "approval", phase: "approval", at: "2026-09-25T00:01:10Z" }),
      event("a", 5, { kind: "status", phase: "running", at: "2026-09-25T00:02:00Z" }),
      event("a", 6, { kind: "message", text: "完成", at: "2026-09-25T00:02:10Z" }),
      event("a", 7, { kind: "status", phase: "ready", text: "本轮已完成", at: "2026-09-25T00:02:30Z" }),
    ];
    store.loadHistory("a", history);
    expect(store.getSnapshot().entries.at(-1)).toMatchObject({
      kind: "turn_end", at: "2026-09-25T00:02:30Z", startedAt: "2026-09-25T00:01:00Z", hasExecutionActivity: true,
    });
    expect(store.getSnapshot().entries.filter((entry) => entry.kind === "turn_end")).toHaveLength(1);
    store.ingest(event("a", 8, { kind: "status", phase: "ready", at: "2026-09-25T00:03:00Z" }));
    expect(store.getSnapshot().entries.filter((entry) => entry.kind === "turn_end")).toHaveLength(1);
    store.loadHistory("a", history);
    expect(store.getSnapshot().entries.filter((entry) => entry.kind === "turn_end")).toHaveLength(1);
  });

  it("marks only turns with tools or approvals for elapsed-time display", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [session("a")], deletedSessions: [], selectedSessionId: "a", lastWorkspace: null });
    store.ingest(event("a", 1, { kind: "user", text: "你好", at: "2026-09-25T00:00:00Z" }));
    store.ingest(event("a", 2, { kind: "message", text: "你好！", at: "2026-09-25T00:00:01Z" }));
    store.ingest(event("a", 3, { kind: "status", phase: "ready", at: "2026-09-25T00:00:02Z" }));

    store.ingest(event("a", 4, { kind: "user", text: "看看目录", at: "2026-09-25T00:01:00Z" }));
    store.ingest(event("a", 5, { kind: "tool", toolCallId: "read-1", toolStatus: "running", at: "2026-09-25T00:01:01Z" }));
    store.ingest(event("a", 6, { kind: "tool", toolCallId: "read-1", toolStatus: "completed", at: "2026-09-25T00:01:02Z" }));
    store.ingest(event("a", 7, { kind: "status", phase: "ready", at: "2026-09-25T00:01:03Z" }));

    store.ingest(event("a", 8, { kind: "user", text: "需要确认", at: "2026-09-25T00:02:00Z" }));
    store.ingest(event("a", 9, { kind: "approval", at: "2026-09-25T00:02:01Z" }));
    store.removeAllApprovals("a");
    store.ingest(event("a", 10, { kind: "status", phase: "ready", at: "2026-09-25T00:02:02Z" }));

    store.ingest(event("a", 11, { kind: "user", text: "谢谢", at: "2026-09-25T00:03:00Z" }));
    store.ingest(event("a", 12, { kind: "message", text: "不客气", at: "2026-09-25T00:03:01Z" }));
    store.ingest(event("a", 13, { kind: "status", phase: "ready", at: "2026-09-25T00:03:02Z" }));

    expect(store.getSnapshot().entries.filter((entry) => entry.kind === "turn_end").map((entry) => entry.hasExecutionActivity))
      .toEqual([false, true, true, false]);
  });

  it("does not invent a finished turn when an interrupted session reconnects", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [session("a")], deletedSessions: [], selectedSessionId: "a", lastWorkspace: null });
    store.loadHistory("a", [
      event("a", 1, { kind: "user", text: "未完成的任务", at: "2026-09-25T00:01:00Z" }),
      event("a", 2, { kind: "status", phase: "running", at: "2026-09-25T00:01:01Z" }),
      event("a", 3, { kind: "status", phase: "starting", at: "2026-09-25T00:10:00Z" }),
      event("a", 4, { kind: "status", phase: "ready", at: "2026-09-25T00:10:01Z" }),
    ]);
    expect(store.getSnapshot().entries.some((entry) => entry.kind === "turn_end")).toBe(false);
  });

  it("keeps two sessions separate and merges saved history with live updates", () => {
    const store = createAgentStore("dsh");
    store.setCatalog({ sessions: [session("b"), session("a")], deletedSessions: [], selectedSessionId: "a", lastWorkspace: null });
    store.ingest(event("a", 2, { kind: "message", text: "after " }));
    store.loadHistory("a", [event("a", 1, { kind: "user", text: "first" })]);
    expect(store.getSnapshot().entries.map((entry) => entry.text)).toEqual(["first", "after "]);
    store.select("b");
    store.ingest(event("b", 1, { kind: "user", text: "second" }));
    expect(store.getSnapshot().entries.map((entry) => entry.text)).toEqual(["second"]);
    store.select("a");
    expect(store.getSnapshot().entries.map((entry) => entry.text)).toEqual(["first", "after "]);
  });

  it("moves a session forward only when a new task starts, not on status noise", () => {
    const store = createAgentStore("dsh");
    const old = { ...session("old"), createdAt: "2026-09-24T00:00:00Z" };
    const recent = { ...session("recent"), createdAt: "2026-09-25T00:00:00Z" };
    store.setCatalog({ sessions: [old, recent], deletedSessions: [], selectedSessionId: "recent", lastWorkspace: null });
    expect(store.getSnapshot().sessions.map((item) => item.id)).toEqual(["recent", "old"]);
    store.ingest(event("old", 1, { kind: "status", phase: "ready", at: "2026-09-26T09:00:00Z" }));
    expect(store.getSnapshot().sessions.map((item) => item.id)).toEqual(["recent", "old"]);
    expect(store.getSnapshot().sessions.find((item) => item.id === "old")?.lastActivityAt).toBeNull();
    store.ingest(event("old", 2, { kind: "user", text: "new work", at: "2026-09-26T10:00:00Z" }));
    expect(store.getSnapshot().sessions.map((item) => item.id)).toEqual(["old", "recent"]);
    expect(store.getSnapshot().sessions[0].lastActivityAt).toBe("2026-09-26T10:00:00Z");
  });
});
