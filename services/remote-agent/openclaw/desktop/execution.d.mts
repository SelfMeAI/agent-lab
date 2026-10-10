export type NativeExecutionEvent = { runId: string; sessionKey?: string; stream: string; ts: number; data: Record<string, unknown> };
export class ExecutionObserver {
  constructor(options?: { directory?: string; onRound?: (task: string) => void | Promise<void>; onError?: (error: unknown) => void });
  observe(event: NativeExecutionEvent): void;
  forget(task: string): Promise<void>;
  dispose(): Promise<void>;
}
