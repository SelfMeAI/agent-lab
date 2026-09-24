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
  model?: string;
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

export type JevStyle = "balanced" | "aggressive" | "positional";

export interface JevCandidate {
  id: string;
  color: "w" | "b";
  from: string;
  to: string;
  lan: string;
  zh: string;
  piece: string;
  capture?: string;
  givesCheck: boolean;
  isCheckmate: boolean;
  description: string;
}

export interface JevDecision {
  move: JevCandidate;
  telemetry: {
    source: "jev" | "local-fallback";
    model: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    choiceConfidence: number;
    probabilities: Record<string, number>;
    positionScore: number;
    positionConfidence: number;
    tacticalPressure: number;
    candidates: JevCandidate[];
  };
  warning?: string;
}

export interface DesktopBridge {
  getAppInfo(): Promise<AppInfo>;
  chooseWorkspace(): Promise<string | null>;
  listRuntimes(): Promise<RuntimeStatus[]>;
  getProviderStatus(runtimeId: string): Promise<ProviderStatus>;
  saveProvider(runtimeId: string, config: { baseUrl: string; apiKey?: string; model?: string }): Promise<ProviderStatus>;
  startRuntime(runtimeId: string, workspace: string): Promise<void>;
  sendPrompt(runtimeId: string, prompt: string): Promise<void>;
  cancelRun(runtimeId: string): Promise<void>;
  respondApproval(runtimeId: string, requestId: string | number, optionId: string): Promise<void>;
  stopRuntime(runtimeId: string): Promise<void>;
  decideJevMove(fen: string, style: JevStyle): Promise<JevDecision>;
  onRunEvent(listener: (event: RunEvent) => void): () => void;
}
