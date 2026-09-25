import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../../../../packages/contracts/src/index";

const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke("selfme:app-info"),
  migrateLegacyWorkspaces: (workspaces) => ipcRenderer.invoke("selfme:migrate-legacy-workspaces", workspaces),
  openExternal: (url) => ipcRenderer.invoke("selfme:open-external", url),
  chooseWorkspace: () => ipcRenderer.invoke("selfme:choose-workspace"),
  listRuntimes: () => ipcRenderer.invoke("selfme:list-runtimes"),
  getProviderStatus: (runtimeId) => ipcRenderer.invoke("selfme:get-provider-status", runtimeId),
  listProviderModels: (runtimeId, config) => ipcRenderer.invoke("selfme:list-provider-models", runtimeId, config),
  saveProvider: (runtimeId, config) => ipcRenderer.invoke("selfme:save-provider", runtimeId, config),
  getAgentSessionCatalog: (runtimeId) => ipcRenderer.invoke("selfme:agent-session-catalog", runtimeId),
  createAgentSession: (runtimeId, workspace) => ipcRenderer.invoke("selfme:create-agent-session", runtimeId, workspace),
  getAgentSessionEvents: (sessionId) => ipcRenderer.invoke("selfme:agent-session-events", sessionId),
  selectAgentSession: (sessionId) => ipcRenderer.invoke("selfme:select-agent-session", sessionId),
  startAgentSession: (sessionId) => ipcRenderer.invoke("selfme:start-agent-session", sessionId),
  sendSessionPrompt: (sessionId, prompt) => ipcRenderer.invoke("selfme:send-session-prompt", sessionId, prompt),
  cancelSessionRun: (sessionId) => ipcRenderer.invoke("selfme:cancel-session-run", sessionId),
  respondSessionApproval: (sessionId, requestId, optionId) => ipcRenderer.invoke("selfme:respond-session-approval", sessionId, requestId, optionId),
  decideJevMove: (fen, style) => ipcRenderer.invoke("selfme:jev-decision", fen, style),
  onRunEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("selfme:run-event", handler);
    return () => ipcRenderer.removeListener("selfme:run-event", handler);
  },
};

contextBridge.exposeInMainWorld("selfmeLab", bridge);
