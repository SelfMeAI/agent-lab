export type NativeAgentEvent = { runId: string; sessionKey?: string; stream: string; ts?: number; data: Record<string, unknown> };

export function isTerminalTool(name: string, kind?: string): boolean {
  return kind !== "code_mode_exec" && /^(exec|bash|process|shell|terminal|run_command)$/.test(name);
}
export function toolIdentity(event: { runId?: string; toolCallId?: string; toolName?: string }, context: { runId?: string; toolCallId?: string } = {}): string {
  return `${context.runId ?? event.runId ?? "native"}:${context.toolCallId ?? event.toolCallId ?? event.toolName ?? "tool"}`;
}

/** Only protects manual input during terminal tool calls; never pauses an agent. */
export class TerminalActivity {
  private calls = new Map<string, string | undefined>();
  private inputs = new Set<Promise<unknown>>();
  constructor(private onChange: () => void = () => {}) {}
  get busy(): boolean { return this.calls.size > 0; }
  beginTool(id: string, runId?: string): void { this.calls.set(id, runId); this.onChange(); }
  endTool(id: string): void { if (this.calls.delete(id)) this.onChange(); }
  observe(event: NativeAgentEvent): void {
    if (!event.runId) return;
    if (event.stream === "lifecycle" && ["end", "error"].includes(String(event.data.phase))) {
      let changed = false;
      for (const [id, runId] of this.calls) if (runId === event.runId) { this.calls.delete(id); changed = true; }
      if (changed) this.onChange();
    } else if (event.stream === "tool" && ["result", "end"].includes(String(event.data.phase))) {
      this.endTool(toolIdentity({ runId: event.runId, toolCallId: typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined, toolName: String(event.data.name ?? "tool") }));
    }
  }
  track<T>(operation: Promise<T>): Promise<T> {
    this.inputs.add(operation);
    void operation.finally(() => this.inputs.delete(operation)).catch(() => {});
    return operation;
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.inputs]); }
  dispose(): void { this.calls.clear(); this.inputs.clear(); this.onChange(); }
}

/** Read-only observation must not bring the native browser to the foreground. */
export function activeBrowserAction(name: string, params: Record<string, unknown>): boolean {
  if (name !== "browser") return false;
  const action = params.action;
  if (["open", "navigate", "focus"].includes(String(action))) return true;
  if (action !== "act") return false;
  const request = params.request && typeof params.request === "object" ? params.request as Record<string, unknown> : params;
  return !["evaluate", "wait"].includes(String(request.kind));
}
