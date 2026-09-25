import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import type { AppInfo } from "../../../../packages/contracts/src/index";
import { AdapterRegistry } from "../../../../packages/runtime/src/index";
import { CodexAdapter } from "../../../../packages/runtime/src/codex";
import { DshAdapter } from "../../../../packages/runtime/src/dsh";
import { KimiAdapter } from "../../../../packages/runtime/src/kimi";
import { PiAdapter } from "../../../../packages/runtime/src/pi";
import {
  getCodexProvider, getCodexProviderStatus, getDshProvider, getDshProviderStatus,
  getJevProviderStatus, getKimiProvider, getKimiProviderStatus, getPiProvider, getPiProviderStatus,
  saveCodexProvider, saveDshProvider, saveJevProvider, saveKimiProvider, savePiProvider,
} from "./provider-store";
import { discoverModels, modelListUrl } from "./model-discovery";
import { decideJevMove } from "./jev-decision";

const registry = new AdapterRegistry();
let mainWindow: BrowserWindow | null = null;
let dsh: DshAdapter;
let codex: CodexAdapter;
let pi: PiAdapter;
let kimi: KimiAdapter;

app.setName("SelfMe Lab");

function assertMainWindow(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Untrusted IPC sender");
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    title: "SelfMe Lab",
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 10, y: 19 } } : {}),
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
  codex = new CodexAdapter({
    executable: app.isPackaged
      ? join(process.resourcesPath, "codex", "bin", "codex")
      : join(__dirname, "../../../../runtimes/codex/bin/codex"),
    homeDirectory: join(app.getPath("userData"), "codex-home"),
    provider: getCodexProvider,
  });
  registry.register(codex);
  pi = new PiAdapter({
    homeDirectory: join(app.getPath("userData"), "pi-home"),
    provider: getPiProvider,
  });
  registry.register(pi);
  kimi = new KimiAdapter({
    executable: app.isPackaged
      ? join(process.resourcesPath, "kimi-code", "bin", "kimi")
      : join(__dirname, "../../../../runtimes/kimi-code/bin/kimi"),
    homeDirectory: join(app.getPath("userData"), "kimi-home"),
    provider: getKimiProvider,
  });
  registry.register(kimi);
  dsh.onEvent((event) => mainWindow?.webContents.send("selfme:run-event", event));
  codex.onEvent((event) => mainWindow?.webContents.send("selfme:run-event", event));
  pi.onEvent((event) => mainWindow?.webContents.send("selfme:run-event", event));
  kimi.onEvent((event) => mainWindow?.webContents.send("selfme:run-event", event));
  ipcMain.handle("selfme:app-info", (event): AppInfo => {
    assertMainWindow(event);
    return { name: app.getName(), version: app.getVersion(), platform: process.platform, arch: process.arch };
  });
  ipcMain.handle("selfme:open-external", async (event, value: string): Promise<void> => {
    assertMainWindow(event);
    const url = new URL(value);
    const allowed = new Set(["developers.openai.com", "modelcontextprotocol.io", "github.com", "code.claude.com", "learn.microsoft.com", "support.google.com", "deepmind.google", "docs.langchain.com"]);
    if (url.protocol !== "https:" || !allowed.has(url.hostname) || url.username || url.password) throw new Error("不允许打开此外部地址");
    await shell.openExternal(url.toString());
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
    if (runtimeId === "dsh") return getDshProviderStatus();
    if (runtimeId === "codex") return getCodexProviderStatus();
    if (runtimeId === "pi") return getPiProviderStatus();
    if (runtimeId === "kimi-code") return getKimiProviderStatus();
    if (runtimeId === "jev") return getJevProviderStatus();
    throw new Error("此运行时暂不支持模型配置");
  });
  ipcMain.handle("selfme:list-provider-models", async (event, runtimeId: string, config: { baseUrl: string; apiKey?: string }) => {
    assertMainWindow(event);
    if (!["dsh", "codex", "pi", "kimi-code"].includes(runtimeId) || !config || typeof config.baseUrl !== "string" || (config.apiKey !== undefined && typeof config.apiKey !== "string")) {
      throw new Error("无效的模型列表请求");
    }
    let apiKey = config.apiKey?.trim();
    if (!apiKey) {
      const saved = runtimeId === "dsh" ? await getDshProvider()
        : runtimeId === "codex" ? await getCodexProvider()
          : runtimeId === "pi" ? await getPiProvider() : await getKimiProvider();
      if (modelListUrl(config.baseUrl) !== modelListUrl(saved.baseUrl)) throw new Error("API 地址已更改，请先填写该地址的 API Key");
      apiKey = saved.apiKey;
    }
    return discoverModels(config.baseUrl, apiKey ?? "");
  });
  ipcMain.handle("selfme:save-provider", async (event, runtimeId: string, config: { baseUrl: string; apiKey?: string; model?: string }) => {
    assertMainWindow(event);
    if (runtimeId === "dsh") {
      if (dsh.isBusy()) throw new Error("当前任务仍在运行，请先完成或取消后修改模型配置");
      const status = await saveDshProvider(config);
      await dsh.stop();
      return status;
    }
    if (runtimeId === "codex") {
      if (codex.isBusy()) throw new Error("当前任务仍在运行，请先完成或取消后修改模型配置");
      const status = await saveCodexProvider(config);
      await codex.stop();
      return status;
    }
    if (runtimeId === "pi") {
      if (pi.isBusy()) throw new Error("当前任务仍在运行，请先完成或取消后修改模型配置");
      const status = await savePiProvider(config);
      await pi.stop();
      return status;
    }
    if (runtimeId === "kimi-code") {
      if (kimi.isBusy()) throw new Error("当前任务仍在运行，请先完成或取消后修改模型配置");
      const status = await saveKimiProvider(config);
      await kimi.stop();
      return status;
    }
    if (runtimeId === "jev") return saveJevProvider(config);
    throw new Error("此运行时暂不支持模型配置");
  });
  ipcMain.handle("selfme:jev-decision", async (event, fen: string, style: "balanced" | "aggressive" | "positional") => {
    assertMainWindow(event);
    return decideJevMove(fen, style);
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
  if (!dsh || !codex || !pi || !kimi || quitAfterCleanup) return;
  event.preventDefault();
  void Promise.allSettled([dsh.stop(), codex.stop(), pi.stop(), kimi.stop()]).finally(() => {
    quitAfterCleanup = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
