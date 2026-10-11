import type { RemoteSceneAccess } from "../../../../packages/contracts/src/remote-agent";

export type SceneResource = "browser" | "terminal";
export interface SceneLease { owner: string; task: string; ready: boolean; stopping?: boolean }

/** Ordinary input conflicts with the corresponding tool, not an entire turn. */
export function sceneAccess(agentBusy: boolean, lease: SceneLease | undefined, owner: string, task: string, browserBusy = false, terminalBusy = false): RemoteSceneAccess {
  const mine = lease?.owner === owner && lease.task === task;
  const inputAllowed = lease ? mine && lease.ready : true;
  return {
    agentBusy, humanControl: !!mine && lease!.ready, inputAllowed,
    browserBusy, terminalBusy,
    browserInputAllowed: inputAllowed && (!!lease || !browserBusy),
    terminalInputAllowed: inputAllowed && (!!lease || !terminalBusy),
    takeover: mine ? lease!.ready ? "ready" : lease!.stopping ? "stopping" : "waiting" : "none",
  };
}

export function toolResource(name: string, kind?: string): SceneResource | undefined {
  if (kind === "code_mode_exec") return;
  if (name === "browser") return "browser";
  if (/^(exec|bash|process|shell|terminal|run_command)$/.test(name)) return "terminal";
}

export function toolIdentity(event: { runId?: string; toolCallId?: string; toolName?: string }, context: { runId?: string; toolCallId?: string } = {}): string {
  return `${context.runId ?? event.runId ?? "native"}:${context.toolCallId ?? event.toolCallId ?? event.toolName ?? "tool"}`;
}

/** Gateway-owned admission and cancellable, same-call waiting at the tool boundary. */
export class SceneActivity {
  private runs = new Set<string>();
  private calls = new Map<string, { runId?: string; resource?: SceneResource }>();
  private inputs = new Map<Promise<unknown>, SceneResource>();
  private grants = new Set<AbortController>();
  private listeners = new Set<() => void>();
  constructor(private onChange: () => void = () => {}) {}
  busy(nativeRuns: number): boolean { return nativeRuns > 0 || this.runs.size > 0; }
  occupied(resource: SceneResource): boolean { return [...this.calls.values()].some(call => call.resource === resource); }
  get pending(): boolean { return this.calls.size > 0 || this.inputs.size > 0; }
  changed(): void { for (const listener of [...this.listeners]) listener(); this.onChange(); }
  beginTool(id: string, runId?: string, resource?: SceneResource): void { this.calls.set(id, { runId, resource }); this.changed(); }
  endTool(id: string): void { if (this.calls.delete(id)) this.changed(); }
  observe(event: { runId: string; stream: string; data: Record<string, unknown> }): void {
    if (!event.runId) return;
    if (event.stream === "lifecycle") {
      if (event.data.phase === "start") this.runs.add(event.runId);
      if (["end", "error"].includes(String(event.data.phase))) {
        this.runs.delete(event.runId);
        for (const [id, call] of this.calls) if (call.runId === event.runId) this.calls.delete(id);
      }
      this.changed();
    } else if (event.stream === "tool" && ["result", "end"].includes(String(event.data.phase))) {
      this.endTool(toolIdentity({ runId: event.runId, toolCallId: typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined, toolName: String(event.data.name ?? "tool") }));
    }
  }
  track<T>(operation: Promise<T>, resource: SceneResource): Promise<T> {
    this.inputs.set(operation, resource);
    void operation.finally(() => { this.inputs.delete(operation); this.changed(); }).catch(() => {});
    return operation;
  }
  async drain(resource?: SceneResource): Promise<void> {
    await Promise.allSettled([...this.inputs].filter(([, kind]) => !resource || kind === resource).map(([promise]) => promise));
  }
  waitUntil(predicate: () => boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { this.listeners.delete(check); signal?.removeEventListener("abort", aborted); };
      const aborted = () => { cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
      const check = () => { if (signal?.aborted) aborted(); else if (predicate()) { cleanup(); resolve(); } };
      this.listeners.add(check); signal?.addEventListener("abort", aborted, { once: true }); check();
    });
  }
  grant(): AbortController { const grant = new AbortController(); this.grants.add(grant); grant.signal.addEventListener("abort", () => this.grants.delete(grant), { once: true }); return grant; }
  revoke(): void { for (const grant of this.grants) grant.abort(); this.grants.clear(); }
  dispose(): void { this.revoke(); this.runs.clear(); this.calls.clear(); this.inputs.clear(); this.changed(); }
}

/** Read-only tools/polls never change the native window stacking. */
export function activeBrowserAction(name: string, params: Record<string, unknown>): boolean {
  if (name !== "browser") return false;
  const action = params.action;
  if (["open", "navigate", "focus"].includes(String(action))) return true;
  if (action !== "act") return false;
  const request = params.request && typeof params.request === "object" ? params.request as Record<string, unknown> : params;
  return !["evaluate", "wait"].includes(String(request.kind));
}
