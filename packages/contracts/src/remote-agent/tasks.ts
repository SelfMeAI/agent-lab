import type { RemoteAgentId } from "./common";

export type RemoteTaskStatus = "idle" | "running" | "waiting" | "paused" | "completed" | "error";
export interface RemoteTask {
  id: string; title: string; status: RemoteTaskStatus; createdAt: string; updatedAt: string;
}
export interface RemoteTool {
  name: string; title: string; input: string; output?: string;
  status: "running" | "completed" | "failed" | "rejected";
  diff?: string; path?: string; startedAt?: string; endedAt?: string;
  parentCallId?: string;
  callId?: string;
}
export interface RemoteApproval {
  id: string; title: string; detail: string; canAlways: boolean;
  kind?: "exec" | "plugin";
  choices?: Array<{ id: string; label: string }>;
}
export interface RemoteQuestion {
  id: string; questions: Array<{ id: string; title: string; prompt: string; options: Array<{ label: string; description?: string }>; multiple: boolean; other: boolean; secret: boolean }>;
}
/** An interrupted execution, not a failed connection or a failed individual tool. */
export interface RemoteFailure { message: string; at?: string; runId?: string }
export interface RemoteItem {
  id: string; role: "user" | "assistant" | "tool" | "notice"; text: string; at?: string;
  reasoning?: string; streaming?: boolean; tool?: RemoteTool; approval?: RemoteApproval; question?: RemoteQuestion; failure?: RemoteFailure;
}
export interface RemoteTaskSnapshot {
  task: RemoteTask; items: RemoteItem[]; connection: "connected" | "reconnecting" | "disconnected";
  error?: string; failure?: RemoteFailure; hasEarlier?: boolean;
}
export interface RemoteTaskUpdate { engine: RemoteAgentId; taskId: string; snapshot: RemoteTaskSnapshot }
export interface RemoteWorkspaceFile { path: string; name: string; size: number; directory: boolean; modifiedAt?: string }
export interface RemoteFilePage { path: string; files: RemoteWorkspaceFile[]; truncated?: boolean }
export interface RemoteUploadedFile extends RemoteWorkspaceFile { absolutePath: string }
export interface RemoteFilePreview { kind: "text" | "image" | "pdf" | "html" | "binary"; url?: string; text?: string; truncated: boolean; size: number; mime: string }
/** Brief input protection while the agent invokes a terminal tool. */
export interface RemoteTerminalAccess { busy: boolean; inputAllowed: boolean }
/** One-use, short-lived native framebuffer credentials, never persisted by the client. */
export interface RemoteDesktopGrant { url: string; password?: string; control: boolean; expiresAt: number }
export interface RemoteTerminal { id: string; cwd: string; confined: boolean; buffer?: string }
export interface RemoteTerminalEvent { engine: RemoteAgentId; taskId: string; terminalId: string; data?: string; exited?: boolean; detail?: string }
export interface RemoteTaskBridge {
  listRemoteTasks(engine: RemoteAgentId): Promise<RemoteTask[]>;
  createRemoteTask(engine: RemoteAgentId): Promise<RemoteTask>;
  openRemoteTask(engine: RemoteAgentId, id: string): Promise<RemoteTaskSnapshot>;
  loadEarlierRemoteTask(engine: RemoteAgentId, id: string): Promise<RemoteTaskSnapshot>;
  closeRemoteTask(engine: RemoteAgentId, id: string): Promise<void>;
  sendRemoteTaskMessage(engine: RemoteAgentId, id: string, text: string, files?: RemoteUploadedFile[]): Promise<void>;
  controlRemoteTask(engine: RemoteAgentId, id: string, action: "stop" | "resume"): Promise<void>;
  deleteRemoteTask(engine: RemoteAgentId, id: string): Promise<void>;
  respondRemoteApproval(engine: RemoteAgentId, id: string, requestId: string, decision: "once" | "always" | "reject", answer?: string): Promise<void>;
  respondRemoteQuestion(engine: RemoteAgentId, id: string, requestId: string, answers: Record<string, string[]> | null): Promise<void>;
  uploadRemoteTaskFiles(engine: RemoteAgentId, id: string, remaining?: number): Promise<RemoteUploadedFile[]>;
  listRemoteTaskFiles(engine: RemoteAgentId, id: string, path?: string): Promise<RemoteFilePage>;
  previewRemoteTaskFile(engine: RemoteAgentId, id: string, path: string): Promise<RemoteFilePreview>;
  downloadRemoteTaskFile(engine: RemoteAgentId, id: string, path: string): Promise<boolean>;
  observeRemoteDesktop(engine: RemoteAgentId, id: string): Promise<RemoteDesktopGrant>;
  getRemoteTerminalAccess(engine: RemoteAgentId, id: string): Promise<RemoteTerminalAccess>;
  openRemoteTerminal(engine: RemoteAgentId, id: string): Promise<RemoteTerminal>;
  inputRemoteTerminal(engine: RemoteAgentId, id: string, terminalId: string, data: string): Promise<void>;
  resizeRemoteTerminal(engine: RemoteAgentId, id: string, terminalId: string, cols: number, rows: number): Promise<void>;
  closeRemoteTerminal(engine: RemoteAgentId, id: string, terminalId: string): Promise<void>;
  onRemoteTaskUpdate(listener: (event: RemoteTaskUpdate) => void): () => void;
  onRemoteTerminalEvent(listener: (event: RemoteTerminalEvent) => void): () => void;
}
