import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../../../../packages/contracts/src/index";

const bridge: DesktopBridge = {
  listRemoteTasks: engine => ipcRenderer.invoke("selfme:remote-task-list", engine),
  createRemoteTask: engine => ipcRenderer.invoke("selfme:remote-task-create", engine),
  openRemoteTask: (engine, id) => ipcRenderer.invoke("selfme:remote-task-open", engine, id),
  loadEarlierRemoteTask: (engine, id) => ipcRenderer.invoke("selfme:remote-task-earlier", engine, id),
  closeRemoteTask: (engine, id) => ipcRenderer.invoke("selfme:remote-task-close", engine, id),
  deleteRemoteTask: (engine, id) => ipcRenderer.invoke("selfme:remote-task-delete", engine, id),
  sendRemoteTaskMessage: (engine, id, prompt, files) => ipcRenderer.invoke("selfme:remote-task-send", engine, id, prompt, files),
  controlRemoteTask: (engine, id, action) => ipcRenderer.invoke("selfme:remote-task-control", engine, id, action),
  respondRemoteApproval: (engine, id, requestId, decision, answer) => ipcRenderer.invoke("selfme:remote-task-approval", engine, id, requestId, decision, answer),
  respondRemoteQuestion: (engine, id, requestId, answers) => ipcRenderer.invoke("selfme:remote-task-question", engine, id, requestId, answers),
  uploadRemoteTaskFiles: (engine, id, remaining) => ipcRenderer.invoke("selfme:remote-task-upload", engine, id, remaining),
  listRemoteTaskFiles: (engine, id, path) => ipcRenderer.invoke("selfme:remote-task-files", engine, id, path),
  previewRemoteTaskFile: (engine, id, path) => ipcRenderer.invoke("selfme:remote-task-preview", engine, id, path),
  downloadRemoteTaskFile: (engine, id, path) => ipcRenderer.invoke("selfme:remote-task-download", engine, id, path),
  observeRemoteDesktop: (engine, id, control) => ipcRenderer.invoke("selfme:remote-task-desktop", engine, id, control),
  observeRemoteBrowser: (engine, id, options) => ipcRenderer.invoke("selfme:remote-task-browser", engine, id, options),
  listRemoteBrowserTabs: (engine, id) => ipcRenderer.invoke("selfme:remote-task-browser-tabs", engine, id),
  returnRemoteDesktop: (engine, id, prompt) => ipcRenderer.invoke("selfme:remote-task-return", engine, id, prompt),
  openRemoteTerminal: (engine, id) => ipcRenderer.invoke("selfme:remote-terminal-open", engine, id),
  inputRemoteTerminal: (engine, id, terminalId, data) => ipcRenderer.invoke("selfme:remote-terminal-input", engine, id, terminalId, data),
  resizeRemoteTerminal: (engine, id, terminalId, cols, rows) => ipcRenderer.invoke("selfme:remote-terminal-resize", engine, id, terminalId, cols, rows),
  closeRemoteTerminal: (engine, id, terminalId) => ipcRenderer.invoke("selfme:remote-terminal-close", engine, id, terminalId),
  onRemoteTaskUpdate: listener => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("selfme:remote-task-update", handler); return () => ipcRenderer.removeListener("selfme:remote-task-update", handler);
  },
  onRemoteTerminalEvent: listener => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("selfme:remote-terminal-event", handler); return () => ipcRenderer.removeListener("selfme:remote-terminal-event", handler);
  },
  getRemoteServiceState: (engine) => ipcRenderer.invoke("selfme:remote-service-state", engine),
  controlRemoteService: (engine, action) => ipcRenderer.invoke("selfme:remote-service-control", engine, action),
  getRemoteServiceLogs: (engine) => ipcRenderer.invoke("selfme:remote-service-logs", engine),
  getRemoteModelConnection: (engine) => ipcRenderer.invoke("selfme:remote-model-get", engine),
  saveRemoteModelConnection: (engine, input) => ipcRenderer.invoke("selfme:remote-model-save", engine, input),
  getAppInfo: () => ipcRenderer.invoke("selfme:app-info"),
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
  deleteAgentSession: (sessionId) => ipcRenderer.invoke("selfme:delete-agent-session", sessionId),
  restoreAgentSession: (sessionId) => ipcRenderer.invoke("selfme:restore-agent-session", sessionId),
  purgeAgentSession: (sessionId) => ipcRenderer.invoke("selfme:purge-agent-session", sessionId),
  startAgentSession: (sessionId) => ipcRenderer.invoke("selfme:start-agent-session", sessionId),
  sendSessionPrompt: (sessionId, prompt) => ipcRenderer.invoke("selfme:send-session-prompt", sessionId, prompt),
  steerSessionPrompt: (sessionId, prompt) => ipcRenderer.invoke("selfme:steer-session-prompt", sessionId, prompt),
  enqueueSessionPrompt: (sessionId, prompt) => ipcRenderer.invoke("selfme:enqueue-session-prompt", sessionId, prompt),
  editQueuedSessionPrompt: (sessionId, messageId, prompt) => ipcRenderer.invoke("selfme:edit-queued-session-prompt", sessionId, messageId, prompt),
  deleteQueuedSessionPrompt: (sessionId, messageId) => ipcRenderer.invoke("selfme:delete-queued-session-prompt", sessionId, messageId),
  moveQueuedSessionPrompt: (sessionId, messageId, direction) => ipcRenderer.invoke("selfme:move-queued-session-prompt", sessionId, messageId, direction),
  steerQueuedSessionPrompt: (sessionId, messageId) => ipcRenderer.invoke("selfme:steer-queued-session-prompt", sessionId, messageId),
  retryQueuedSessionPrompt: (sessionId, messageId) => ipcRenderer.invoke("selfme:retry-queued-session-prompt", sessionId, messageId),
  resumeSessionQueue: (sessionId) => ipcRenderer.invoke("selfme:resume-session-queue", sessionId),
  pauseSessionQueue: (sessionId) => ipcRenderer.invoke("selfme:pause-session-queue", sessionId),
  setSessionFollowUpMode: (sessionId, mode) => ipcRenderer.invoke("selfme:set-session-follow-up-mode", sessionId, mode),
  cancelSessionRun: (sessionId) => ipcRenderer.invoke("selfme:cancel-session-run", sessionId),
  respondSessionApproval: (sessionId, requestId, optionId, answers) => ipcRenderer.invoke("selfme:respond-session-approval", sessionId, requestId, optionId, answers),
  decideJevMove: (fen, style) => ipcRenderer.invoke("selfme:jev-decision", fen, style),
  runJevExperiment: (experimentId, state) => ipcRenderer.invoke("selfme:jev-experiment", experimentId, state),
  getLocalModelState: () => ipcRenderer.invoke("selfme:local-model-state"),
  getLocalModelDetails: (model) => ipcRenderer.invoke("selfme:local-model-details", model),
  saveLocalModelPreferences: (value) => ipcRenderer.invoke("selfme:local-model-preferences", value),
  startLocalModelRun: (value) => ipcRenderer.invoke("selfme:local-model-run", value),
  stopLocalModelRun: () => ipcRenderer.invoke("selfme:local-model-stop"),
  pullLocalModel: (model) => ipcRenderer.invoke("selfme:local-model-pull", model),
  pauseLocalModelDownload: () => ipcRenderer.invoke("selfme:local-model-pause-download"),
  resumeLocalModelDownload: () => ipcRenderer.invoke("selfme:local-model-resume-download"),
  stopLocalModelDownload: () => ipcRenderer.invoke("selfme:local-model-stop-download"),
  unloadLocalModel: (model) => ipcRenderer.invoke("selfme:local-model-unload", model),
  deleteLocalModel: (model) => ipcRenderer.invoke("selfme:local-model-delete", model),
  getLocalModelRun: (id) => ipcRenderer.invoke("selfme:local-model-history-run", id),
  getLatestLocalModelRun: (mode, models) => ipcRenderer.invoke("selfme:local-model-latest-run", mode, models),
  deleteLocalModelRun: (id) => ipcRenderer.invoke("selfme:local-model-delete-run", id),
  chooseLocalModelDirectory: () => ipcRenderer.invoke("selfme:local-model-choose-directory"),
  openLocalModelDirectory: () => ipcRenderer.invoke("selfme:local-model-open-directory"),
  onLocalModelEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("selfme:local-model-event", handler);
    return () => ipcRenderer.removeListener("selfme:local-model-event", handler);
  },
  onRunEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("selfme:run-event", handler);
    return () => ipcRenderer.removeListener("selfme:run-event", handler);
  },
  onAgentQueueChange: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("selfme:agent-queue-change", handler);
    return () => ipcRenderer.removeListener("selfme:agent-queue-change", handler);
  },
};

contextBridge.exposeInMainWorld("selfmeLab", bridge);
