import type { RemoteSceneAccess } from "../../../../packages/contracts/src/remote-agent";

/** Input admission is independent of observation and of an explicit takeover. */
export function sceneAccess(agentBusy: boolean, lease: { owner: string; task: string; ready: boolean } | undefined, owner: string, task: string): RemoteSceneAccess {
  const humanControl = lease?.owner === owner && lease.task === task;
  return { agentBusy, humanControl, inputAllowed: lease ? humanControl && lease.ready : !agentBusy };
}

/** Events are a fast fence; the native active-run registry remains authoritative. */
export class SceneActivity {
  private runs = new Set<string>();
  private starting = 0;
  private inputs = new Set<Promise<unknown>>();
  private grants = new Set<AbortController>();
  busy(nativeRuns: number, includeStarting = true): boolean { return nativeRuns > 0 || this.runs.size > 0 || (includeStarting && this.starting > 0); }
  observe(event: { runId: string; stream: string; data: Record<string, unknown> }): boolean {
    if (event.stream !== "lifecycle" || !event.runId) return false;
    if (event.data.phase === "start") { this.runs.add(event.runId); this.revoke(); return true; }
    if (["end", "error"].includes(String(event.data.phase))) { this.runs.delete(event.runId); return true; }
    return false;
  }
  beginStart(): () => void { ++this.starting; this.revoke(); let ended = false; return () => { if (!ended) { ended = true; --this.starting; } }; }
  track<T>(operation: Promise<T>): Promise<T> { this.inputs.add(operation); void operation.finally(() => this.inputs.delete(operation)).catch(() => {}); return operation; }
  async drain(): Promise<void> { await Promise.allSettled([...this.inputs]); }
  grant(): AbortController { const grant = new AbortController(); this.grants.add(grant); grant.signal.addEventListener("abort", () => this.grants.delete(grant), { once: true }); return grant; }
  revoke(): void { for (const grant of this.grants) grant.abort(); this.grants.clear(); }
  dispose(): void { this.revoke(); this.runs.clear(); this.inputs.clear(); this.starting = 0; }
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
