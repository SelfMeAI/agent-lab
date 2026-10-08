export interface LocalModelInfo {
  name: string;
  digest: string;
  size: number;
  parameterSize: string;
  quantization: string;
  loaded: boolean;
  memoryBytes: number | null;
}
export interface LocalModelDetails {
  capabilities: string[];
  contextLength: number | null;
  thinkingLevels: string[];
}
export interface LocalModelParameters {
  temperature: number;
  contextLength: number;
  seed: number | null;
  maxTokens: number;
  thinking: "auto" | "off";
}
export interface LocalModelPreferences {
  selectedModel: string | null;
  modelA: string | null;
  modelB: string | null;
  parameters: LocalModelParameters;
}
export interface LocalModelMetrics {
  firstOutputMs: number | null;
  durationMs: number | null;
  loadMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensPerSecond: number | null;
}
export type LocalModelRunStatus = "pending" | "running" | "complete" | "stopped" | "error" | "interrupted";
export interface LocalModelOutput {
  model: string;
  digest: string;
  parameterSize: string;
  quantization: string;
  status: LocalModelRunStatus;
  text: string;
  thinking: string;
  error: string | null;
  metrics: LocalModelMetrics;
  finishReason?: string | null;
}
export interface LocalModelRun {
  id: string;
  mode: "playground" | "compare";
  prompt: string;
  systemPrompt: string;
  parameters: LocalModelParameters;
  createdAt: string;
  completedAt: string | null;
  status: LocalModelRunStatus;
  outputs: LocalModelOutput[];
}
export interface LocalModelRunSummary {
  id: string;
  mode: LocalModelRun["mode"];
  prompt: string;
  models: string[];
  createdAt: string;
  status: LocalModelRunStatus;
}
export interface LocalModelDownload {
  model: string;
  status: "downloading" | "pausing" | "paused" | "cancelling" | "cancelled" | "complete" | "error";
  message: string;
  completed: number | null;
  total: number | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  bytesPerSecond: number | null;
  remainingSeconds: number | null;
}
export interface LocalModelSnapshot {
  runtime: { status: "starting" | "ready" | "error"; version: string | null; endpoint: string | null; error: string | null };
  modelsDirectory: string;
  models: LocalModelInfo[];
  preferences: LocalModelPreferences;
  activeRun: LocalModelRun | null;
  latestRun: LocalModelRun | null;
  history: LocalModelRunSummary[];
  download: LocalModelDownload | null;
}
export type LocalModelEvent =
  | { type: "run"; run: LocalModelRun }
  | { type: "download"; download: LocalModelDownload }
  | { type: "state"; state: LocalModelSnapshot };
export interface LocalModelRunRequest {
  mode: LocalModelRun["mode"];
  models: string[];
  prompt: string;
  systemPrompt: string;
  parameters: LocalModelParameters;
}
