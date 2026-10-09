/** OpenHands API contracts. Remote workspaces never refer to host directories. */
import type { RemoteServiceState } from "./common";

export interface RemoteConversation {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteAgentEvent {
  id: string;
  kind: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface RemoteFile {
  path: string;
  bytes: number;
  uploaded?: boolean;
}

export interface RemoteConversationSnapshot {
  conversation: RemoteConversation;
  events: RemoteAgentEvent[];
}

/** Not exposed by DesktopBridge until the real IPC implementation is connected. */
export interface OpenHandsAgentBridge {
  getRemoteServiceState(): Promise<RemoteServiceState>;
  startRemoteService(): Promise<RemoteServiceState>;
  stopRemoteService(): Promise<RemoteServiceState>;
  restartRemoteService(): Promise<RemoteServiceState>;
  getRemoteServiceLogs(): Promise<string>;
  listRemoteConversations(): Promise<RemoteConversation[]>;
  createRemoteConversation(): Promise<RemoteConversation>;
  getRemoteConversation(id: string): Promise<RemoteConversationSnapshot>;
  sendRemoteMessage(id: string, prompt: string, imagePaths?: string[]): Promise<void>;
  pauseRemoteConversation(id: string): Promise<void>;
  resumeRemoteConversation(id: string): Promise<void>;
  confirmRemoteAction(id: string, decision: "once" | "session" | "reject"): Promise<void>;
  deleteRemoteConversation(id: string): Promise<void>;
  uploadRemoteFiles(id: string): Promise<RemoteFile[]>;
  listRemoteFiles(id: string): Promise<RemoteFile[]>;
  previewRemoteFile(id: string, path: string): Promise<{ text?: string; image?: string; truncated: boolean }>;
  downloadRemoteFile(id: string, path: string): Promise<boolean>;
  onRemoteAgentEvent(listener: (event: { conversationId: string; event: RemoteAgentEvent }) => void): () => void;
}
