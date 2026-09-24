import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../../../../packages/contracts/src/index";

const bridge: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke("selfme:app-info"),
  chooseWorkspace: () => ipcRenderer.invoke("selfme:choose-workspace"),
  listRuntimes: () => ipcRenderer.invoke("selfme:list-runtimes"),
};

contextBridge.exposeInMainWorld("selfmeLab", bridge);
