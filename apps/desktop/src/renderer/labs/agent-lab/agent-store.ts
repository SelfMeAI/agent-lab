import type { AgentRuntimeId, AgentSessionCatalog, AgentSessionEvent, AgentSessionSummary, ApprovalRequest, RuntimePhase } from "../../../../../../packages/contracts/src/index";

export type { AgentRuntimeId } from "../../../../../../packages/contracts/src/index";

export interface TranscriptEntry {
  id: string;
  kind: "user" | "message" | "thought" | "tool" | "approval" | "error" | "status" | "turn_end";
  runId: string;
  text: string;
  title?: string;
  toolCallId?: string;
  toolStatus?: string;
  approval?: ApprovalRequest;
  raw?: unknown;
  at: string;
  startedAt?: string;
  finishedAt?: string;
}

interface ConversationSnapshot {
  entries: TranscriptEntry[];
  phase: RuntimePhase;
  statusText: string;
  currentTask: string | null;
}

export interface AgentSnapshot extends ConversationSnapshot {
  sessions: AgentSessionSummary[];
  deletedSessions: AgentSessionSummary[];
  selectedSessionId: string | null;
  lastWorkspace: string | null;
  loaded: boolean;
}

const emptyConversation = (): ConversationSnapshot => ({ entries: [], phase: "idle", statusText: "尚未连接", currentTask: null });
const activityKinds = new Set(["user", "message", "tool", "approval", "artifact", "error"]);

/** Sort on task starts, not status/tool events, so active rows do not jump. */
export function recentSessions(sessions: readonly AgentSessionSummary[]): AgentSessionSummary[] {
  return [...sessions].sort((a, b) => {
    const recent = (b.lastPromptAt ?? b.createdAt).localeCompare(a.lastPromptAt ?? a.createdAt);
    return recent || b.createdAt.localeCompare(a.createdAt);
  });
}

function applyEvent(snapshot: ConversationSnapshot, event: AgentSessionEvent): ConversationSnapshot {
  if (event.kind === "user") {
    const text = event.text?.trim() ?? "";
    return {
      ...snapshot, currentTask: text, phase: "running", statusText: "正在执行任务",
      entries: [...snapshot.entries, { id: `${event.sessionId}:${event.eventIndex}`, kind: "user", runId: event.runId, text, at: event.at }],
    };
  }
  if (event.kind === "status" && event.raw && typeof event.raw === "object" && "sessionUpdate" in event.raw && event.raw.sessionUpdate === "usage_update") return snapshot;
  if (event.kind === "status" && event.phase) {
    let entries = snapshot.entries;
    if (event.phase === "ready" && ["running", "approval", "cancelling"].includes(snapshot.phase)) {
      let lastUserIndex = entries.length - 1;
      while (lastUserIndex >= 0 && entries[lastUserIndex].kind !== "user") lastUserIndex--;
      const user = entries[lastUserIndex];
      if (user && !entries.slice(lastUserIndex + 1).some((entry) => entry.kind === "turn_end")) {
        entries = [...entries, {
          id: `${event.sessionId}:${event.eventIndex}`, kind: "turn_end", runId: user.runId,
          text: event.text ?? "", at: event.at, startedAt: user.at,
        }];
      }
    }
    return { ...snapshot, entries, phase: event.phase, statusText: event.text ?? event.phase };
  }
  if (event.kind === "status" && !event.raw) return snapshot;
  const kind = event.kind;
  if (!["message", "thought", "tool", "approval", "error", "status"].includes(kind)) return snapshot;
  const entries = [...snapshot.entries];
  if ((kind === "message" || kind === "thought") && event.text) {
    const last = entries.at(-1);
    if (last && last.kind === kind && last.runId === event.runId) {
      entries[entries.length - 1] = { ...last, text: last.text + event.text };
      return { ...snapshot, entries };
    }
  }
  if (kind === "tool" && event.toolCallId) {
    const index = entries.findIndex((entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId && entry.runId === event.runId);
    if (index >= 0) {
      const finished = ["completed", "finished", "failed", "interrupted", "cancelled", "canceled"].includes(event.toolStatus ?? "");
      entries[index] = {
        ...entries[index], text: event.text ?? entries[index].text,
        title: event.title ?? entries[index].title, toolStatus: event.toolStatus ?? entries[index].toolStatus,
        finishedAt: finished ? event.at : entries[index].finishedAt,
        raw: event.raw && typeof event.raw === "object" && !Array.isArray(event.raw)
          && entries[index].raw && typeof entries[index].raw === "object" && !Array.isArray(entries[index].raw)
          ? { ...entries[index].raw, ...event.raw } : event.raw ?? entries[index].raw,
      };
      return { ...snapshot, entries };
    }
  }
  entries.push({
    id: `${event.sessionId}:${event.eventIndex}`, kind: kind as TranscriptEntry["kind"], runId: event.runId,
    text: event.text ?? "", title: event.title, toolCallId: event.toolCallId,
    toolStatus: event.toolStatus, approval: event.approval, raw: event.raw, at: event.at,
  });
  return { ...snapshot, entries, phase: kind === "approval" ? "approval" : kind === "error" ? "error" : snapshot.phase };
}

export function createAgentStore(runtimeId: AgentRuntimeId) {
  let snapshot: AgentSnapshot = { ...emptyConversation(), sessions: [], deletedSessions: [], selectedSessionId: null, lastWorkspace: null, loaded: false };
  const conversations = new Map<string, ConversationSnapshot>();
  const eventMaps = new Map<string, Map<number, AgentSessionEvent>>();
  const listeners = new Set<() => void>();
  const publish = (next: AgentSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const display = (sessionId: string | null): ConversationSnapshot => {
    if (!sessionId) return emptyConversation();
    return conversations.get(sessionId) ?? {
      ...emptyConversation(),
      phase: snapshot.sessions.find((item) => item.id === sessionId)?.phase ?? "idle",
      statusText: snapshot.sessions.find((item) => item.id === sessionId)?.statusText ?? "尚未连接",
    };
  };
  const updateSession = (event: AgentSessionEvent): AgentSessionSummary[] => {
    const sessions = snapshot.sessions.map((session) => {
    if (session.id !== event.sessionId) return session;
    const title = event.kind === "user" && session.title === "新会话" && event.text?.trim()
      ? event.text.trim().replace(/\s+/gu, " ").slice(0, 55) : session.title;
    const phase = event.phase ?? (event.kind === "error" ? "error" : session.phase);
    const statusText = event.phase || event.kind === "error" ? event.text ?? phase : session.statusText;
    return { ...session, title, phase, statusText,
      lastPromptAt: event.kind === "user" ? event.at : session.lastPromptAt,
      lastActivityAt: activityKinds.has(event.kind) ? event.at : session.lastActivityAt,
      updatedAt: event.kind === "user" || event.phase || event.kind === "error" ? event.at : session.updatedAt };
    });
    return event.kind === "user" ? recentSessions(sessions) : sessions;
  };
  return {
    getSnapshot: (): AgentSnapshot => snapshot,
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    setCatalog(catalog: AgentSessionCatalog): void {
      const selectedSessionId = catalog.selectedSessionId;
      const record = catalog.sessions.find((item) => item.id === selectedSessionId);
      const conversation = conversations.get(selectedSessionId ?? "") ?? {
        ...emptyConversation(), phase: record?.phase ?? "idle", statusText: record?.statusText ?? "尚未连接",
      };
      publish({ ...conversation, sessions: recentSessions(catalog.sessions), deletedSessions: catalog.deletedSessions, selectedSessionId, lastWorkspace: catalog.lastWorkspace, loaded: true });
    },
    select(sessionId: string): void {
      publish({ ...display(sessionId), sessions: snapshot.sessions, deletedSessions: snapshot.deletedSessions, selectedSessionId: sessionId, lastWorkspace: snapshot.lastWorkspace, loaded: true });
    },
    loadHistory(sessionId: string, history: AgentSessionEvent[]): void {
      const events = eventMaps.get(sessionId) ?? new Map<number, AgentSessionEvent>();
      for (const event of history) if (event.sessionId === sessionId) events.set(event.eventIndex, event);
      eventMaps.set(sessionId, events);
      let conversation = emptyConversation();
      for (const event of [...events.values()].sort((a, b) => a.eventIndex - b.eventIndex)) conversation = applyEvent(conversation, event);
      const record = snapshot.sessions.find((item) => item.id === sessionId);
      if (record) conversation = { ...conversation, phase: record.phase, statusText: record.statusText,
        entries: record.phase === "approval" ? conversation.entries : conversation.entries.filter((entry) => entry.kind !== "approval") };
      conversations.set(sessionId, conversation);
      if (snapshot.selectedSessionId === sessionId) publish({ ...snapshot, ...conversation });
    },
    addSession(session: AgentSessionSummary): void {
      const sessions = recentSessions([session, ...snapshot.sessions.filter((item) => item.id !== session.id)]);
      publish({ ...emptyConversation(), sessions, deletedSessions: snapshot.deletedSessions, selectedSessionId: session.id, lastWorkspace: session.workspace, loaded: true });
    },
    removeApproval(sessionId: string, requestId: string | number): void {
      const conversation = conversations.get(sessionId);
      if (!conversation) return;
      const next = { ...conversation, entries: conversation.entries.filter((entry) => entry.approval?.requestId !== requestId) };
      conversations.set(sessionId, next);
      if (snapshot.selectedSessionId === sessionId) publish({ ...snapshot, ...next });
    },
    removeAllApprovals(sessionId: string): void {
      const conversation = conversations.get(sessionId);
      if (!conversation) return;
      const next = { ...conversation, entries: conversation.entries.filter((entry) => entry.kind !== "approval") };
      conversations.set(sessionId, next);
      if (snapshot.selectedSessionId === sessionId) publish({ ...snapshot, ...next });
    },
    ingest(event: AgentSessionEvent): void {
      if (event.runtimeId !== runtimeId) return;
      const events = eventMaps.get(event.sessionId) ?? new Map<number, AgentSessionEvent>();
      if (events.has(event.eventIndex)) return;
      events.set(event.eventIndex, event);
      eventMaps.set(event.sessionId, events);
      const conversation = applyEvent(conversations.get(event.sessionId) ?? emptyConversation(), event);
      conversations.set(event.sessionId, conversation);
      const sessions = updateSession(event);
      if (snapshot.selectedSessionId === event.sessionId) publish({ ...snapshot, ...conversation, sessions });
      else publish({ ...snapshot, sessions });
    },
  };
}

export const agentStores = {
  dsh: createAgentStore("dsh"), codex: createAgentStore("codex"),
  pi: createAgentStore("pi"), "kimi-code": createAgentStore("kimi-code"),
};

let unsubscribeBridge: (() => void) | null = null;

export function attachAgentEvents(): () => void {
  if (!unsubscribeBridge && window.selfmeLab) {
    unsubscribeBridge = window.selfmeLab.onRunEvent((event) => {
      if (event.runtimeId === "dsh" || event.runtimeId === "codex" || event.runtimeId === "pi" || event.runtimeId === "kimi-code") agentStores[event.runtimeId].ingest(event);
    });
  }
  return () => { unsubscribeBridge?.(); unsubscribeBridge = null; };
}
