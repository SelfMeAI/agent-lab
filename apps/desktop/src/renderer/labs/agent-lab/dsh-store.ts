import type { ApprovalRequest, RunEvent, RuntimePhase } from "../../../../../../packages/contracts/src/index";

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

export interface DshSnapshot {
  entries: TranscriptEntry[];
  phase: RuntimePhase;
  statusText: string;
  currentTask: string | null;
}

let snapshot: DshSnapshot = { entries: [], phase: "idle", statusText: "尚未连接", currentTask: null };
const listeners = new Set<() => void>();
let unsubscribeBridge: (() => void) | null = null;

function publish(next: DshSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getDshSnapshot(): DshSnapshot {
  return snapshot;
}

export function subscribeDshStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function attachDshEvents(): () => void {
  if (!unsubscribeBridge && window.selfmeLab) unsubscribeBridge = window.selfmeLab.onRunEvent(ingestDshEvent);
  return () => {
    unsubscribeBridge?.();
    unsubscribeBridge = null;
  };
}

export function addDshUserPrompt(text: string): void {
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
}

export function removeDshApproval(requestId: string | number): void {
  publish({ ...snapshot, entries: snapshot.entries.filter((entry) => entry.approval?.requestId !== requestId) });
}

export function removeAllDshApprovals(): void {
  publish({ ...snapshot, entries: snapshot.entries.filter((entry) => entry.kind !== "approval") });
}

export function clearDshTranscript(): void {
  publish({ entries: [], phase: "idle", statusText: "正在创建新会话", currentTask: null });
}

export function ingestDshEvent(event: RunEvent): void {
  if (event.runtimeId !== "dsh") return;
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
        raw: event.raw ?? entries[index].raw,
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
}
