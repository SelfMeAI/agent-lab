import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import type { AppInfo } from "../../../../packages/contracts/src/index";
import { AdapterRegistry } from "../../../../packages/runtime/src/index";
import { DshAdapter } from "../../../../packages/runtime/src/dsh";
import { getDshProvider, getDshProviderStatus, saveDshProvider } from "./provider-store";

const registry = new AdapterRegistry();
let mainWindow: BrowserWindow | null = null;
let dsh: DshAdapter;

app.setName("SelfMe Lab");

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
  const entryPoint = app.isPackaged
    ? join(process.resourcesPath, "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
    : join(__dirname, "../../../../runtimes/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
  dsh = new DshAdapter({
    entryPoint,
    homeDirectory: join(app.getPath("userData"), "dsh-home"),
    nodeExecutable: process.execPath,
    provider: getDshProvider,
  });
  registry.register(dsh);
  dsh.onEvent((event) => mainWindow?.webContents.send("selfme:run-event", event));
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
  ipcMain.handle("selfme:get-provider-status", async (event, runtimeId: string) => {
    assertMainWindow(event);
    if (runtimeId !== "dsh") throw new Error("此运行时暂不支持模型配置");
    return getDshProviderStatus();
  });
  ipcMain.handle("selfme:save-provider", async (event, runtimeId: string, config: { baseUrl: string; apiKey?: string }) => {
    assertMainWindow(event);
    if (runtimeId !== "dsh") throw new Error("此运行时暂不支持模型配置");
    if (dsh.isBusy()) throw new Error("当前任务仍在运行，请先完成或取消后修改模型配置");
    const status = await saveDshProvider(config);
    await dsh.stop();
    return status;
  });
  ipcMain.handle("selfme:start-runtime", async (event, runtimeId: string, workspace: string) => {
    assertMainWindow(event);
    const adapter = registry.get(runtimeId);
    if (!adapter) throw new Error("运行时尚未接入");
    await adapter.start(workspace);
  });
  ipcMain.handle("selfme:send-prompt", async (event, runtimeId: string, prompt: string) => {
    assertMainWindow(event);
    const adapter = registry.get(runtimeId);
    if (!adapter) throw new Error("运行时尚未接入");
    await adapter.send(prompt);
  });
  ipcMain.handle("selfme:cancel-run", async (event, runtimeId: string) => {
    assertMainWindow(event);
    const adapter = registry.get(runtimeId);
    if (!adapter) throw new Error("运行时尚未接入");
    await adapter.cancel();
  });
  ipcMain.handle("selfme:respond-approval", async (event, runtimeId: string, requestId: string | number, optionId: string) => {
    assertMainWindow(event);
    const adapter = registry.get(runtimeId);
    if (!adapter) throw new Error("运行时尚未接入");
    await adapter.respondApproval(requestId, optionId);
  });
  ipcMain.handle("selfme:stop-runtime", async (event, runtimeId: string) => {
    assertMainWindow(event);
    const adapter = registry.get(runtimeId);
    if (!adapter) throw new Error("运行时尚未接入");
    await adapter.stop();
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitAfterCleanup = false;
app.on("before-quit", (event) => {
  if (!dsh || quitAfterCleanup) return;
  event.preventDefault();
  void dsh.stop().finally(() => {
    quitAfterCleanup = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
