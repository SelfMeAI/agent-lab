import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../../../../packages/contracts/src/index";

const bridge: DesktopBridge = {
  listRemoteTasks: engine => ipcRenderer.invoke("agent-lab:remote-task-list", engine),
  createRemoteTask: engine => ipcRenderer.invoke("agent-lab:remote-task-create", engine),
  openRemoteTask: (engine, id) => ipcRenderer.invoke("agent-lab:remote-task-open", engine, id),
  loadEarlierRemoteTask: (engine, id) => ipcRenderer.invoke("agent-lab:remote-task-earlier", engine, id),
  closeRemoteTask: (engine, id) => ipcRenderer.invoke("agent-lab:remote-task-close", engine, id),
  deleteRemoteTask: (engine, id) => ipcRenderer.invoke("agent-lab:remote-task-delete", engine, id),
  sendRemoteTaskMessage: (engine, id, prompt, files, options) => ipcRenderer.invoke("agent-lab:remote-task-send", engine, id, prompt, files, options),
  getRemoteInputQueue: (engine, id) => ipcRenderer.invoke("agent-lab:remote-inputs-state", engine, id),
  setRemoteInputMode: (engine, id, mode) => ipcRenderer.invoke("agent-lab:remote-inputs-mode", engine, id, mode),
  removeRemoteQueuedMessage: (engine, id, messageId) => ipcRenderer.invoke("agent-lab:remote-inputs-remove", engine, id, messageId),
  steerRemoteQueuedMessage: (engine, id, messageId) => ipcRenderer.invoke("agent-lab:remote-inputs-steer", engine, id, messageId),
  controlRemoteTask: (engine, id, action) => ipcRenderer.invoke("agent-lab:remote-task-control", engine, id, action),
  respondRemoteApproval: (engine, id, requestId, decision, answer) => ipcRenderer.invoke("agent-lab:remote-task-approval", engine, id, requestId, decision, answer),
  respondRemoteQuestion: (engine, id, requestId, answers) => ipcRenderer.invoke("agent-lab:remote-task-question", engine, id, requestId, answers),
  uploadRemoteTaskFiles: (engine, id, remaining) => ipcRenderer.invoke("agent-lab:remote-task-upload", engine, id, remaining),
  listRemoteTaskFiles: (engine, id, path) => ipcRenderer.invoke("agent-lab:remote-task-files", engine, id, path),
  previewRemoteTaskFile: (engine, id, path) => ipcRenderer.invoke("agent-lab:remote-task-preview", engine, id, path),
  downloadRemoteTaskFile: (engine, id, path) => ipcRenderer.invoke("agent-lab:remote-task-download", engine, id, path),
  observeRemoteDesktop: (engine, id) => ipcRenderer.invoke("agent-lab:remote-task-desktop", engine, id),
  getRemoteTerminalAccess: (engine, id) => ipcRenderer.invoke("agent-lab:remote-terminal-access", engine, id),
  openRemoteTerminal: (engine, id) => ipcRenderer.invoke("agent-lab:remote-terminal-open", engine, id),
  inputRemoteTerminal: (engine, id, terminalId, data) => ipcRenderer.invoke("agent-lab:remote-terminal-input", engine, id, terminalId, data),
  resizeRemoteTerminal: (engine, id, terminalId, cols, rows) => ipcRenderer.invoke("agent-lab:remote-terminal-resize", engine, id, terminalId, cols, rows),
  closeRemoteTerminal: (engine, id, terminalId) => ipcRenderer.invoke("agent-lab:remote-terminal-close", engine, id, terminalId),
  onRemoteTaskUpdate: listener => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("agent-lab:remote-task-update", handler); return () => ipcRenderer.removeListener("agent-lab:remote-task-update", handler);
  },
  onRemoteTerminalEvent: listener => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("agent-lab:remote-terminal-event", handler); return () => ipcRenderer.removeListener("agent-lab:remote-terminal-event", handler);
  },
  getRemoteServiceState: (engine) => ipcRenderer.invoke("agent-lab:remote-service-state", engine),
  controlRemoteService: (engine, action) => ipcRenderer.invoke("agent-lab:remote-service-control", engine, action),
  getRemoteServiceLogs: (engine) => ipcRenderer.invoke("agent-lab:remote-service-logs", engine),
  getRemoteModelConnection: (engine) => ipcRenderer.invoke("agent-lab:remote-model-get", engine),
  saveRemoteModelConnection: (engine, input) => ipcRenderer.invoke("agent-lab:remote-model-save", engine, input),
  listRemoteProviderModels: (engine, input) => ipcRenderer.invoke("agent-lab:remote-model-list", engine, input),
  getAppInfo: () => ipcRenderer.invoke("agent-lab:app-info"),
  openExternal: (url) => ipcRenderer.invoke("agent-lab:open-external", url),
  chooseWorkspace: () => ipcRenderer.invoke("agent-lab:choose-workspace"),
  listRuntimes: () => ipcRenderer.invoke("agent-lab:list-runtimes"),
  getProviderStatus: (runtimeId) => ipcRenderer.invoke("agent-lab:get-provider-status", runtimeId),
  listProviderModels: (runtimeId, config) => ipcRenderer.invoke("agent-lab:list-provider-models", runtimeId, config),
  saveProvider: (runtimeId, config) => ipcRenderer.invoke("agent-lab:save-provider", runtimeId, config),
  getAgentSessionCatalog: (runtimeId) => ipcRenderer.invoke("agent-lab:agent-session-catalog", runtimeId),
  createAgentSession: (runtimeId, workspace) => ipcRenderer.invoke("agent-lab:create-agent-session", runtimeId, workspace),
  getAgentSessionEvents: (sessionId) => ipcRenderer.invoke("agent-lab:agent-session-events", sessionId),
  selectAgentSession: (sessionId) => ipcRenderer.invoke("agent-lab:select-agent-session", sessionId),
  deleteAgentSession: (sessionId) => ipcRenderer.invoke("agent-lab:delete-agent-session", sessionId),
  restoreAgentSession: (sessionId) => ipcRenderer.invoke("agent-lab:restore-agent-session", sessionId),
  purgeAgentSession: (sessionId) => ipcRenderer.invoke("agent-lab:purge-agent-session", sessionId),
  startAgentSession: (sessionId) => ipcRenderer.invoke("agent-lab:start-agent-session", sessionId),
  sendSessionPrompt: (sessionId, prompt) => ipcRenderer.invoke("agent-lab:send-session-prompt", sessionId, prompt),
  steerSessionPrompt: (sessionId, prompt) => ipcRenderer.invoke("agent-lab:steer-session-prompt", sessionId, prompt),
  enqueueSessionPrompt: (sessionId, prompt) => ipcRenderer.invoke("agent-lab:enqueue-session-prompt", sessionId, prompt),
  editQueuedSessionPrompt: (sessionId, messageId, prompt) => ipcRenderer.invoke("agent-lab:edit-queued-session-prompt", sessionId, messageId, prompt),
  deleteQueuedSessionPrompt: (sessionId, messageId) => ipcRenderer.invoke("agent-lab:delete-queued-session-prompt", sessionId, messageId),
  moveQueuedSessionPrompt: (sessionId, messageId, direction) => ipcRenderer.invoke("agent-lab:move-queued-session-prompt", sessionId, messageId, direction),
  steerQueuedSessionPrompt: (sessionId, messageId) => ipcRenderer.invoke("agent-lab:steer-queued-session-prompt", sessionId, messageId),
  retryQueuedSessionPrompt: (sessionId, messageId) => ipcRenderer.invoke("agent-lab:retry-queued-session-prompt", sessionId, messageId),
  resumeSessionQueue: (sessionId) => ipcRenderer.invoke("agent-lab:resume-session-queue", sessionId),
  pauseSessionQueue: (sessionId) => ipcRenderer.invoke("agent-lab:pause-session-queue", sessionId),
  setSessionFollowUpMode: (sessionId, mode) => ipcRenderer.invoke("agent-lab:set-session-follow-up-mode", sessionId, mode),
  cancelSessionRun: (sessionId) => ipcRenderer.invoke("agent-lab:cancel-session-run", sessionId),
  respondSessionApproval: (sessionId, requestId, optionId, answers) => ipcRenderer.invoke("agent-lab:respond-session-approval", sessionId, requestId, optionId, answers),
  decideJevMove: (fen, style) => ipcRenderer.invoke("agent-lab:jev-decision", fen, style),
  runJevExperiment: (experimentId, state) => ipcRenderer.invoke("agent-lab:jev-experiment", experimentId, state),
  getLocalModelState: () => ipcRenderer.invoke("agent-lab:local-model-state"),
  getLocalModelDetails: (model) => ipcRenderer.invoke("agent-lab:local-model-details", model),
  saveLocalModelPreferences: (value) => ipcRenderer.invoke("agent-lab:local-model-preferences", value),
  startLocalModelRun: (value) => ipcRenderer.invoke("agent-lab:local-model-run", value),
  stopLocalModelRun: () => ipcRenderer.invoke("agent-lab:local-model-stop"),
  pullLocalModel: (model) => ipcRenderer.invoke("agent-lab:local-model-pull", model),
  pauseLocalModelDownload: () => ipcRenderer.invoke("agent-lab:local-model-pause-download"),
  resumeLocalModelDownload: () => ipcRenderer.invoke("agent-lab:local-model-resume-download"),
  stopLocalModelDownload: () => ipcRenderer.invoke("agent-lab:local-model-stop-download"),
  unloadLocalModel: (model) => ipcRenderer.invoke("agent-lab:local-model-unload", model),
  deleteLocalModel: (model) => ipcRenderer.invoke("agent-lab:local-model-delete", model),
  getLocalModelRun: (id) => ipcRenderer.invoke("agent-lab:local-model-history-run", id),
  getLatestLocalModelRun: (mode, models) => ipcRenderer.invoke("agent-lab:local-model-latest-run", mode, models),
  deleteLocalModelRun: (id) => ipcRenderer.invoke("agent-lab:local-model-delete-run", id),
  chooseLocalModelDirectory: () => ipcRenderer.invoke("agent-lab:local-model-choose-directory"),
  openLocalModelDirectory: () => ipcRenderer.invoke("agent-lab:local-model-open-directory"),
  onLocalModelEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("agent-lab:local-model-event", handler);
    return () => ipcRenderer.removeListener("agent-lab:local-model-event", handler);
  },
  onRunEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("agent-lab:run-event", handler);
    return () => ipcRenderer.removeListener("agent-lab:run-event", handler);
  },
  onAgentQueueChange: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("agent-lab:agent-queue-change", handler);
    return () => ipcRenderer.removeListener("agent-lab:agent-queue-change", handler);
  },
};

contextBridge.exposeInMainWorld("agentLab", bridge);
