import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import type { AgentRuntimeId, AppInfo } from "../../../../packages/contracts/src/index";
import type { HarnessAdapter } from "../../../../packages/runtime/src/index";
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
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";
import { AgentSessionController } from "./agent-session-controller";

let mainWindow: BrowserWindow | null = null;
let sessions: AgentSessionController | null = null;
let sessionRepository: AgentSessionRepository | null = null;

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

function makeAdapter(runtimeId: AgentRuntimeId, sessionId: string): HarnessAdapter {
  const homeDirectory = join(app.getPath("userData"), "runtime-homes", runtimeId, sessionId);
  const entryPoint = app.isPackaged
    ? join(process.resourcesPath, "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
    : join(__dirname, "../../../../runtimes/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
  if (runtimeId === "dsh") return new DshAdapter({
    entryPoint, homeDirectory, nodeExecutable: process.execPath, provider: getDshProvider,
  });
  if (runtimeId === "codex") return new CodexAdapter({
    executable: app.isPackaged
      ? join(process.resourcesPath, "codex", "bin", "codex")
      : join(__dirname, "../../../../runtimes/codex/bin/codex"),
    homeDirectory, provider: getCodexProvider,
  });
  if (runtimeId === "pi") return new PiAdapter({ homeDirectory, provider: getPiProvider });
  return new KimiAdapter({
    executable: app.isPackaged
      ? join(process.resourcesPath, "kimi-code", "bin", "kimi")
      : join(__dirname, "../../../../runtimes/kimi-code/bin/kimi"),
    homeDirectory, provider: getKimiProvider,
  });
}

void app.whenReady().then(async () => {
  const root = app.getPath("userData");
  sessionRepository = new AgentSessionRepository(root);
  await sessionRepository.init();
  const appConfig = new AppConfigStore(root);
  await appConfig.init();
  sessions = new AgentSessionController(sessionRepository, appConfig, makeAdapter,
    (event) => mainWindow?.webContents.send("selfme:run-event", event), false,
    join(root, "runtime-homes"));
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
    return Promise.all((["dsh", "codex", "pi", "kimi-code"] as const).map((runtimeId) => makeAdapter(runtimeId, "probe").probe()));
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
      if (sessions!.isBusy("dsh")) throw new Error("当前任务仍在运行，请先完成或取消后修改模型配置");
      const status = await saveDshProvider(config);
      await sessions!.stopRuntime("dsh");
      return status;
    }
    if (runtimeId === "codex") {
      if (sessions!.isBusy("codex")) throw new Error("当前任务仍在运行，请先完成或取消后修改模型配置");
      const status = await saveCodexProvider(config);
      await sessions!.stopRuntime("codex");
      return status;
    }
    if (runtimeId === "pi") {
      if (sessions!.isBusy("pi")) throw new Error("当前任务仍在运行，请先完成或取消后修改模型配置");
      const status = await savePiProvider(config);
      await sessions!.stopRuntime("pi");
      return status;
    }
    if (runtimeId === "kimi-code") {
      if (sessions!.isBusy("kimi-code")) throw new Error("当前任务仍在运行，请先完成或取消后修改模型配置");
      const status = await saveKimiProvider(config);
      await sessions!.stopRuntime("kimi-code");
      return status;
    }
    if (runtimeId === "jev") return saveJevProvider(config);
    throw new Error("此运行时暂不支持模型配置");
  });
  ipcMain.handle("selfme:jev-decision", async (event, fen: string, style: "balanced" | "aggressive" | "positional") => {
    assertMainWindow(event);
    return decideJevMove(fen, style);
  });
  ipcMain.handle("selfme:agent-session-catalog", async (event, runtimeId: AgentRuntimeId) => {
    assertMainWindow(event);
    return sessions!.catalog(runtimeId);
  });
  ipcMain.handle("selfme:create-agent-session", async (event, runtimeId: AgentRuntimeId, workspace: string) => {
    assertMainWindow(event);
    return sessions!.create(runtimeId, workspace);
  });
  ipcMain.handle("selfme:agent-session-events", async (event, sessionId: string) => {
    assertMainWindow(event);
    return sessions!.events(sessionId);
  });
  ipcMain.handle("selfme:select-agent-session", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.select(sessionId);
  });
  ipcMain.handle("selfme:delete-agent-session", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.delete(sessionId);
  });
  ipcMain.handle("selfme:restore-agent-session", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.restore(sessionId);
  });
  ipcMain.handle("selfme:purge-agent-session", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.purge(sessionId);
  });
  ipcMain.handle("selfme:start-agent-session", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.activate(sessionId);
  });
  ipcMain.handle("selfme:send-session-prompt", async (event, sessionId: string, prompt: string) => {
    assertMainWindow(event);
    await sessions!.send(sessionId, prompt);
  });
  ipcMain.handle("selfme:cancel-session-run", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.cancel(sessionId);
  });
  ipcMain.handle("selfme:respond-session-approval", async (event, sessionId: string, requestId: string | number, optionId: string) => {
    assertMainWindow(event);
    await sessions!.respondApproval(sessionId, requestId, optionId);
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  sessionRepository?.close();
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("SelfMe Lab 无法启动", `读取本地会话或配置失败：${message}`);
  app.quit();
});

let quitAfterCleanup = false;
app.on("before-quit", (event) => {
  if (!sessions || quitAfterCleanup) return;
  event.preventDefault();
  void sessions.stopAll().finally(() => {
    sessionRepository?.close();
    quitAfterCleanup = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
