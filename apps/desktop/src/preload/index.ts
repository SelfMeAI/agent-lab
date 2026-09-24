import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../../../../packages/contracts/src/index";

const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke("selfme:app-info"),
  chooseWorkspace: () => ipcRenderer.invoke("selfme:choose-workspace"),
  listRuntimes: () => ipcRenderer.invoke("selfme:list-runtimes"),
  getProviderStatus: (runtimeId) => ipcRenderer.invoke("selfme:get-provider-status", runtimeId),
  saveProvider: (runtimeId, config) => ipcRenderer.invoke("selfme:save-provider", runtimeId, config),
  startRuntime: (runtimeId, workspace) => ipcRenderer.invoke("selfme:start-runtime", runtimeId, workspace),
  sendPrompt: (runtimeId, prompt) => ipcRenderer.invoke("selfme:send-prompt", runtimeId, prompt),
  cancelRun: (runtimeId) => ipcRenderer.invoke("selfme:cancel-run", runtimeId),
  respondApproval: (runtimeId, requestId, optionId) => ipcRenderer.invoke("selfme:respond-approval", runtimeId, requestId, optionId),
  stopRuntime: (runtimeId) => ipcRenderer.invoke("selfme:stop-runtime", runtimeId),
  onRunEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on("selfme:run-event", handler);
    return () => ipcRenderer.removeListener("selfme:run-event", handler);
  },
};

contextBridge.exposeInMainWorld("selfmeLab", bridge);
