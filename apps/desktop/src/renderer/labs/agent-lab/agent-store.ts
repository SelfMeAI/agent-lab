import type { ApprovalRequest, RunEvent, RuntimePhase } from "../../../../../../packages/contracts/src/index";

export type AgentRuntimeId = "dsh" | "codex" | "pi" | "kimi-code";

export interface TranscriptEntry {
  id: string;
  kind: "user" | "message" | "thought" | "tool" | "approval" | "error" | "status";
  runId: string;
  text: string;
  title?: string;
  toolCallId?: string;
  toolStatus?: string;
  approval?: ApprovalRequest;
  raw?: unknown;
  at: string;
}

export interface AgentSnapshot {
  entries: TranscriptEntry[];
  phase: RuntimePhase;
  statusText: string;
  currentTask: string | null;
}

function createAgentStore(runtimeId: AgentRuntimeId) {
  let snapshot: AgentSnapshot = { entries: [], phase: "idle", statusText: "尚未连接", currentTask: null };
  const listeners = new Set<() => void>();
  const publish = (next: AgentSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: (): AgentSnapshot => snapshot,
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    addUserPrompt(text: string): void {
      const trimmed = text.trim();
      if (!trimmed) return;
      publish({
        ...snapshot,
        currentTask: trimmed,
        phase: "running",
        statusText: "正在执行任务",
        entries: [...snapshot.entries, {
          id: crypto.randomUUID(), kind: "user", runId: "local", text: trimmed, at: new Date().toISOString(),
        }],
      });
    },
    removeApproval(requestId: string | number): void {
      publish({ ...snapshot, entries: snapshot.entries.filter((entry) => entry.approval?.requestId !== requestId) });
    },
    removeAllApprovals(): void {
      publish({ ...snapshot, entries: snapshot.entries.filter((entry) => entry.kind !== "approval") });
    },
    clearTranscript(): void {
      publish({ entries: [], phase: "idle", statusText: "正在创建新会话", currentTask: null });
    },
    ingest(event: RunEvent): void {
      if (event.runtimeId !== runtimeId) return;
      if (event.kind === "status" && event.raw && typeof event.raw === "object" && "sessionUpdate" in event.raw && event.raw.sessionUpdate === "usage_update") return;
      if (event.kind === "status" && event.phase) {
        publish({ ...snapshot, phase: event.phase, statusText: event.text ?? event.phase });
        return;
      }
      if (event.kind === "status" && !event.raw) return;
      const kind = event.kind;
      if (!["message", "thought", "tool", "approval", "error", "status"].includes(kind)) return;
      const entries = [...snapshot.entries];
      if ((kind === "message" || kind === "thought") && event.text) {
        const last = entries.at(-1);
        if (last && last.kind === kind && last.runId === event.runId) {
          entries[entries.length - 1] = { ...last, text: last.text + event.text };
          publish({ ...snapshot, entries });
          return;
        }
      }
      if (kind === "tool" && event.toolCallId) {
        const index = entries.findIndex((entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId && entry.runId === event.runId);
        if (index >= 0) {
          entries[index] = {
            ...entries[index],
            text: event.text ?? entries[index].text,
            title: event.title ?? entries[index].title,
            toolStatus: event.toolStatus ?? entries[index].toolStatus,
            raw: event.raw && typeof event.raw === "object" && !Array.isArray(event.raw)
              && entries[index].raw && typeof entries[index].raw === "object" && !Array.isArray(entries[index].raw)
              ? { ...entries[index].raw, ...event.raw }
              : event.raw ?? entries[index].raw,
          };
          publish({ ...snapshot, entries });
          return;
        }
      }
      entries.push({
        id: `${event.runId}:${event.sequence}`,
        kind: kind as TranscriptEntry["kind"],
        runId: event.runId,
        text: event.text ?? "",
        title: event.title,
        toolCallId: event.toolCallId,
        toolStatus: event.toolStatus,
        approval: event.approval,
        raw: event.raw,
        at: event.at,
      });
      publish({ ...snapshot, entries, phase: kind === "approval" ? "approval" : kind === "error" ? "error" : snapshot.phase });
    },
  };
}

export const agentStores = {
  dsh: createAgentStore("dsh"),
  codex: createAgentStore("codex"),
  pi: createAgentStore("pi"),
  "kimi-code": createAgentStore("kimi-code"),
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
