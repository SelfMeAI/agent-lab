export type LabId =
  | "agent-lab"
  | "remote-agent-lab"
  | "local-model-lab"
  | "jev-lab"
  | "harness-forge"
  | "rsi-lab"
  | "founder-studio";

export type LabGroup = "runtimes" | "engines" | "studio";

export interface LabView {
  id: string;
  label: string;
  designId: string;
}

export interface LabDefinition {
  id: LabId;
  title: string;
  group: LabGroup;
  accent: string;
  symbol: string;
  views: readonly LabView[];
}

export type RuntimeAvailability = "ready" | "missing" | "not-integrated";

export interface RuntimeStatus {
  id: string;
  label: string;
  availability: RuntimeAvailability;
  detail?: string;
}

export type RuntimePhase = "idle" | "starting" | "ready" | "running" | "approval" | "cancelling" | "error";

export interface ProviderStatus {
  configured: boolean;
  baseUrl: string;
}

export interface ApprovalOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface ApprovalRequest {
  requestId: string | number;
  title: string;
  options: ApprovalOption[];
  toolCallId?: string;
}

export type RunEventKind =
  | "message"
  | "thought"
  | "tool"
  | "approval"
  | "artifact"
  | "status"
  | "error";

export interface RunEvent {
  runtimeId: string;
  runId: string;
  sequence: number;
  at: string;
  source: string;
  kind: RunEventKind;
  text?: string;
  title?: string;
  phase?: RuntimePhase;
  approval?: ApprovalRequest;
  toolCallId?: string;
  toolStatus?: string;
  raw?: unknown;
}

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
}

export interface DesktopBridge {
  getAppInfo(): Promise<AppInfo>;
  chooseWorkspace(): Promise<string | null>;
  listRuntimes(): Promise<RuntimeStatus[]>;
  getProviderStatus(runtimeId: string): Promise<ProviderStatus>;
  saveProvider(runtimeId: string, config: { baseUrl: string; apiKey?: string }): Promise<ProviderStatus>;
  startRuntime(runtimeId: string, workspace: string): Promise<void>;
  sendPrompt(runtimeId: string, prompt: string): Promise<void>;
  cancelRun(runtimeId: string): Promise<void>;
  respondApproval(runtimeId: string, requestId: string | number, optionId: string): Promise<void>;
  stopRuntime(runtimeId: string): Promise<void>;
  onRunEvent(listener: (event: RunEvent) => void): () => void;
}
