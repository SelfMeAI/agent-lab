import type { RunEvent, RuntimeStatus } from "../../contracts/src/index";

export interface HarnessAdapter {
  readonly id: string;
  readonly label: string;
  probe(): Promise<RuntimeStatus>;
  start(workspace: string, resumeRef?: string): Promise<void>;
  getResumeRef(): string | null;
  send(prompt: string): Promise<void>;
  steer(prompt: string, messageId: string): Promise<void>;
  cancel(): Promise<void>;
  respondApproval(requestId: string | number, optionId: string): Promise<void>;
  stop(): Promise<void>;
  onEvent(listener: (event: RunEvent) => void): () => void;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>();

  register(adapter: HarnessAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Runtime adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): HarnessAdapter | undefined {
    return this.adapters.get(id);
  }

  async list(): Promise<RuntimeStatus[]> {
    return Promise.all([...this.adapters.values()].map((adapter) => adapter.probe()));
  }
}
