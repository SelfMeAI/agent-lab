export const remoteAgentIds = ["openhands", "openclaw"] as const;
export type RemoteAgentId = typeof remoteAgentIds[number];

export function isRemoteAgentId(value: unknown): value is RemoteAgentId {
  return typeof value === "string" && (remoteAgentIds as readonly string[]).includes(value);
}

export interface RemoteServiceState {
  phase: "stopped" | "starting" | "stopping" | "ready" | "error";
  running: boolean;
  dockerAvailable: boolean;
  imageReady: boolean;
  version: string;
  endpoint: string | null;
  detail: string;
  setupWarning?: string;
}

export type RemoteModelProtocol = "openai" | "anthropic";
export interface RemoteModelConnection {
  protocol: RemoteModelProtocol;
  baseUrl: string;
  model: string;
  configured: boolean;
  /** Native runtime declaration; not proof of an unknown provider's capability. */
  supportsImages?: boolean;
}
export interface RemoteModelInput {
  protocol: RemoteModelProtocol;
  baseUrl: string;
  model: string;
  /** Omitted or empty keeps the server's existing key. Never returned to the UI. */
  apiKey?: string;
}
export interface RemoteModelListInput {
  protocol: RemoteModelProtocol;
  baseUrl: string;
  /** Omitted reuses only this server's saved key for the same address/protocol. */
  apiKey?: string;
}
export interface RemoteServiceBridge {
  getRemoteServiceState(engine: RemoteAgentId): Promise<RemoteServiceState>;
  controlRemoteService(engine: RemoteAgentId, action: "start" | "stop" | "restart"): Promise<RemoteServiceState>;
  getRemoteServiceLogs(engine: RemoteAgentId): Promise<string>;
  getRemoteModelConnection(engine: RemoteAgentId): Promise<RemoteModelConnection>;
  saveRemoteModelConnection(engine: RemoteAgentId, value: RemoteModelInput): Promise<RemoteModelConnection>;
  listRemoteProviderModels(engine: RemoteAgentId, value: RemoteModelListInput): Promise<string[]>;
}
