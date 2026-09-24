import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import type { AppInfo } from "../../../../packages/contracts/src/index";
import { AdapterRegistry } from "../../../../packages/runtime/src/index";

const registry = new AdapterRegistry();
let mainWindow: BrowserWindow | null = null;

function assertMainWindow(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Untrusted IPC sender");
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    title: "SelfMe Lab",
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#070b10",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    const current = new URL(window.webContents.getURL());
    const next = new URL(destination);
    if (next.protocol !== current.protocol || next.pathname !== current.pathname) {
      event.preventDefault();
    }
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("selfme:app-info", (event): AppInfo => {
    assertMainWindow(event);
    return { name: app.getName(), version: app.getVersion(), platform: process.platform, arch: process.arch };
  });
  ipcMain.handle("selfme:choose-workspace", async (event): Promise<string | null> => {
    assertMainWindow(event);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "选择工作目录",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("selfme:list-runtimes", async (event) => {
    assertMainWindow(event);
    return registry.list();
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
