import type { LocalModelDetails, LocalModelEvent, LocalModelPreferences, LocalModelRun, LocalModelRunRequest, LocalModelSnapshot } from "./local-model";
import type { RemoteServiceBridge, RemoteTaskBridge } from "./remote-agent";
export * from "./local-model";
export * from "./remote-agent";

export type LabId =
  | "agent-lab"
  | "remote-agent-lab"
  | "local-model-lab"
  | "jev-lab"
  | "harness-forge"
  | "rsi-lab"
  | "founder-studio";

export type LabGroup = "overviews" | "runtimes" | "engines";

export interface LabView {
  id: string;
  label: string;
  designId: string;
  designStatus?: "approved" | "pending";
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

export const agentRuntimeIds = ["dsh", "codex", "pi", "kimi-code", "qwen-code", "claude-code"] as const;
export type AgentRuntimeId = typeof agentRuntimeIds[number];
export function isAgentRuntimeId(value: unknown): value is AgentRuntimeId {
  return typeof value === "string" && (agentRuntimeIds as readonly string[]).includes(value);
}

export type FollowUpMode = "queue" | "steer";

export interface PendingAgentMessage {
  id: string;
  text: string;
  createdAt: string;
  mode: FollowUpMode;
  state: "queued" | "sending" | "awaiting" | "unconfirmed";
  detail?: string;
}

export interface AgentSessionQueue {
  messages: PendingAgentMessage[];
  paused: boolean;
}

export interface AgentQueueChange {
  sessionId: string;
  queue: AgentSessionQueue;
}

export interface AgentSessionSummary {
  id: string;
  runtimeId: AgentRuntimeId;
  workspace: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastPromptAt: string | null;
  lastActivityAt: string | null;
  phase: RuntimePhase;
  statusText: string;
  followUpMode: FollowUpMode;
}

export interface AgentSessionCatalog {
  sessions: AgentSessionSummary[];
  deletedSessions: AgentSessionSummary[];
  selectedSessionId: string | null;
  lastWorkspace: string | null;
  queues?: Record<string, AgentSessionQueue>;
}

export interface ProviderStatus {
  configured: boolean;
  baseUrl: string;
  model?: string;
}

export interface ApprovalOption {
  optionId: string;
  name: string;
  kind: string;
  detail?: string;
}

export interface ApprovalRequest {
  requestId: string | number;
  title: string;
  options: ApprovalOption[];
  toolCallId?: string;
  /** Present (even if empty) for user questions, never a permission grant. */
  questions?: AgentQuestion[];
}

export interface AgentQuestion {
  id: string;
  header: string;
  question: string;
  detail?: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
  allowCustom: boolean;
  secret?: boolean;
}

export type AgentQuestionAnswers = Record<string, string[]>;

export type RunEventKind =
  | "user"
  | "delivery"
  | "message"
  | "thought"
  | "tool"
  | "approval"
  | "approval_result"
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
  messageId?: string;
  deliveryMode?: FollowUpMode;
  deliveryState?: "submitting" | "queued" | "incorporated" | "unconfirmed" | "rejected";
  text?: string;
  title?: string;
  phase?: RuntimePhase;
  approval?: ApprovalRequest;
  /** Exact selected option, absent for expiry/cancellation and legacy receipts. */
  approvalDecision?: ApprovalOption;
  approvalDecisionSource?: "user" | "restored";
  toolCallId?: string;
  toolStatus?: string;
  raw?: unknown;
}

export interface AgentSessionEvent extends RunEvent {
  sessionId: string;
  eventIndex: number;
}

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
}

export type JevStyle = "balanced" | "aggressive" | "positional";
export type JevExperimentId = "agent-review" | "customer-action" | "invoice-routing";

export interface JevExperimentDecision {
  experimentId: JevExperimentId;
  actionId: string;
  confidence: number | null;
  probabilities: Record<string, number>;
  urgencyScore: number | null;
  urgencyConfidence: number | null;
  anomalyProbability: number | null;
  model: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

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
    inputTokens: number | null;
    outputTokens: number | null;
    choiceConfidence: number | null;
    probabilities: Record<string, number>;
    positionScore: number | null;
    positionConfidence: number | null;
    tacticalPressure: number | null;
    candidates: JevCandidate[];
  };
  warning?: string;
}

export interface DesktopBridge extends RemoteServiceBridge, RemoteTaskBridge {
  getLocalModelState(): Promise<LocalModelSnapshot>;
  getLocalModelDetails(model: string): Promise<LocalModelDetails>;
  saveLocalModelPreferences(preferences: LocalModelPreferences): Promise<LocalModelPreferences>;
  startLocalModelRun(request: LocalModelRunRequest): Promise<LocalModelRun>;
  stopLocalModelRun(): Promise<void>;
  pullLocalModel(model: string): Promise<void>;
  pauseLocalModelDownload(): Promise<void>;
  resumeLocalModelDownload(): Promise<void>;
  stopLocalModelDownload(): Promise<void>;
  unloadLocalModel(model: string): Promise<void>;
  deleteLocalModel(model: string): Promise<void>;
  getLocalModelRun(id: string): Promise<LocalModelRun>;
  getLatestLocalModelRun(mode: LocalModelRun["mode"], models: string[]): Promise<LocalModelRun | null>;
  deleteLocalModelRun(id: string): Promise<void>;
  chooseLocalModelDirectory(): Promise<string | null>;
  openLocalModelDirectory(): Promise<void>;
  onLocalModelEvent(listener: (event: LocalModelEvent) => void): () => void;
  getAppInfo(): Promise<AppInfo>;
  openExternal(url: string): Promise<void>;
  chooseWorkspace(): Promise<string | null>;
  listRuntimes(): Promise<RuntimeStatus[]>;
  getProviderStatus(runtimeId: string): Promise<ProviderStatus>;
  listProviderModels(runtimeId: string, config: { baseUrl: string; apiKey?: string }): Promise<string[]>;
  saveProvider(runtimeId: string, config: { baseUrl: string; apiKey?: string; model?: string }): Promise<ProviderStatus>;
  getAgentSessionCatalog(runtimeId: AgentRuntimeId): Promise<AgentSessionCatalog>;
  createAgentSession(runtimeId: AgentRuntimeId, workspace: string): Promise<AgentSessionSummary>;
  getAgentSessionEvents(sessionId: string): Promise<AgentSessionEvent[]>;
  selectAgentSession(sessionId: string): Promise<void>;
  deleteAgentSession(sessionId: string): Promise<void>;
  restoreAgentSession(sessionId: string): Promise<void>;
  purgeAgentSession(sessionId: string): Promise<void>;
  startAgentSession(sessionId: string): Promise<void>;
  sendSessionPrompt(sessionId: string, prompt: string): Promise<void>;
  steerSessionPrompt(sessionId: string, prompt: string): Promise<void>;
  enqueueSessionPrompt(sessionId: string, prompt: string): Promise<void>;
  editQueuedSessionPrompt(sessionId: string, messageId: string, prompt: string): Promise<void>;
  deleteQueuedSessionPrompt(sessionId: string, messageId: string): Promise<void>;
  moveQueuedSessionPrompt(sessionId: string, messageId: string, direction: "up" | "down"): Promise<void>;
  steerQueuedSessionPrompt(sessionId: string, messageId: string): Promise<void>;
  retryQueuedSessionPrompt(sessionId: string, messageId: string): Promise<void>;
  resumeSessionQueue(sessionId: string): Promise<void>;
  pauseSessionQueue(sessionId: string): Promise<void>;
  setSessionFollowUpMode(sessionId: string, mode: FollowUpMode): Promise<void>;
  cancelSessionRun(sessionId: string): Promise<void>;
  respondSessionApproval(sessionId: string, requestId: string | number, optionId: string, answers?: AgentQuestionAnswers): Promise<void>;
  decideJevMove(fen: string, style: JevStyle): Promise<JevDecision>;
  runJevExperiment(experimentId: JevExperimentId, state: string): Promise<JevExperimentDecision>;
  onRunEvent(listener: (event: AgentSessionEvent) => void): () => void;
  onAgentQueueChange(listener: (change: AgentQueueChange) => void): () => void;
}
