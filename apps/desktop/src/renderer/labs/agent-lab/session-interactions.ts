import type { AgentRuntimeId } from "./agent-store";

export interface SessionInteraction {
  prompt: string;
  error: string | null;
  connecting: boolean;
  submitting: boolean;
  stopping: boolean;
  changingMode: boolean;
  approvalBusy: boolean;
}

const empty: SessionInteraction = Object.freeze({
  prompt: "", error: null, connecting: false, submitting: false,
  stopping: false, changingMode: false, approvalBusy: false,
});

/** Ephemeral UI state survives navigation, but never crosses session boundaries.
 * Durable conversations, queues and send preferences remain in SQLite. */
export function createSessionInteractions() {
  let snapshot: Readonly<Record<string, SessionInteraction>> = {};
  const listeners = new Set<() => void>();
  const get = (id: string | null): SessionInteraction => snapshot[id ?? ""] ?? empty;
  return {
    get,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(id: string | null, patch: Partial<SessionInteraction> | ((current: SessionInteraction) => Partial<SessionInteraction>)): void {
      const current = get(id);
      snapshot = { ...snapshot, [id ?? ""]: { ...current, ...(typeof patch === "function" ? patch(current) : patch) } };
      for (const listener of listeners) listener();
    },
    forget(id: string): void {
      const { [id]: _removed, ...rest } = snapshot;
      snapshot = rest;
      for (const listener of listeners) listener();
    },
  };
}

export const sessionInteractions: Record<AgentRuntimeId, ReturnType<typeof createSessionInteractions>> = {
  dsh: createSessionInteractions(), codex: createSessionInteractions(),
  pi: createSessionInteractions(), "kimi-code": createSessionInteractions(),
  "qwen-code": createSessionInteractions(),
};
