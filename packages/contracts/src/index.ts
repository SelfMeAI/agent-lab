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

export type RunEventKind =
  | "message"
  | "thought"
  | "tool"
  | "approval"
  | "artifact"
  | "status"
  | "error";

export interface RunEvent {
  runId: string;
  sequence: number;
  at: string;
  source: string;
  kind: RunEventKind;
  text?: string;
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
}
