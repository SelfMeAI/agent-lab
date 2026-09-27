import { app, BrowserWindow, dialog, ipcMain, net, shell, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { agentRuntimeIds, isAgentRuntimeId, type AgentQuestionAnswers, type AgentRuntimeId, type AppInfo, type FollowUpMode } from "../../../../packages/contracts/src/index";
import type { HarnessAdapter } from "../../../../packages/runtime/src/index";
import { CodexAdapter } from "../../../../packages/runtime/src/codex";
import { DshAdapter } from "../../../../packages/runtime/src/dsh";
import { KimiAdapter } from "../../../../packages/runtime/src/kimi";
import { PiAdapter } from "../../../../packages/runtime/src/pi";
import { QwenAdapter } from "../../../../packages/runtime/src/qwen";
import { ClaudeAdapter } from "../../../../packages/runtime/src/claude";
import {
  getCodexProvider, getCodexProviderStatus, getDshProvider, getDshProviderStatus,
  getJevProviderStatus, getKimiProvider, getKimiProviderStatus, getPiProvider, getPiProviderStatus,
  saveCodexProvider, saveDshProvider, saveJevProvider, saveKimiProvider, savePiProvider,
  getQwenProvider, getQwenProviderStatus, saveQwenProvider,
  getClaudeProvider, getClaudeProviderStatus, saveClaudeProvider,
} from "./provider-store";
import { discoverModels, modelListUrl } from "./model-discovery";
import { decideJevMove } from "./jev-decision";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";
import { AgentSessionController } from "./agent-session-controller";
import { installAppShutdown } from "./app-shutdown";
import { harnessNodeExecutable } from "./harness-node";

let mainWindow: BrowserWindow | null = null;
let sessions: AgentSessionController | null = null;
let sessionRepository: AgentSessionRepository | null = null;
const shutdown = installAppShutdown(app,
  async () => { await sessions?.stopAll(); },
  () => sessionRepository?.close(),
  (error) => console.error("停止本地运行时失败：", error));

app.setName("SelfMe Lab");

function assertMainWindow(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Untrusted IPC sender");
  }
}

function createWindow(): void {
  if (shutdown.isQuitting()) return;
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
  const nodeExecutable = ["codex", "pi", "claude-code"].includes(runtimeId) ? process.execPath : harnessNodeExecutable(process.execPath);
  const homeDirectory = join(app.getPath("userData"), "runtime-homes", runtimeId, sessionId);
  const permissions = sessionId === "probe" ? undefined : sessionRepository!.permissionStore(sessionId);
  const runtimeRoot = app.isPackaged ? process.resourcesPath : join(__dirname, "../../../../runtimes");
  const entryPoint = app.isPackaged
    ? join(process.resourcesPath, "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
    : join(__dirname, "../../../../runtimes/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
  if (runtimeId === "dsh") return new DshAdapter({
    entryPoint, homeDirectory, nodeExecutable, provider: getDshProvider,
    steeringLoader: join(runtimeRoot, "dsh/steering-loader.mjs"),
  });
  if (runtimeId === "codex") return new CodexAdapter({
    executable: app.isPackaged
      ? join(process.resourcesPath, "codex", "bin", "codex")
      : join(__dirname, "../../../../runtimes/codex/bin/codex"),
    homeDirectory, provider: getCodexProvider, permissions,
  });
  if (runtimeId === "pi") return new PiAdapter({ homeDirectory, provider: getPiProvider, permissions });
  if (runtimeId === "claude-code") return new ClaudeAdapter({
    executable: join(runtimeRoot, "claude", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
    homeDirectory, provider: getClaudeProvider,
    permissions,
  });
  if (runtimeId === "qwen-code") return new QwenAdapter({
    entryPoint: join(runtimeRoot, "qwen-code/node_modules/@qwen-code/qwen-code/cli-entry.js"),
    nodeExecutable, homeDirectory, provider: getQwenProvider, permissions,
  });
  return new KimiAdapter({
    entryPoint: join(runtimeRoot, "kimi-code/node_modules/@moonshot-ai/kimi-code/dist/main.mjs"),
    nodeExecutable,
    steeringLoader: join(runtimeRoot, "kimi-code/steering-loader.mjs"),
    homeDirectory, provider: getKimiProvider,
  });
}

void app.whenReady().then(async () => {
  const root = app.getPath("userData");
  const appConfig = new AppConfigStore(root);
  await appConfig.init();
  sessionRepository = new AgentSessionRepository(root);
  await sessionRepository.init(appConfig.getLegacyFollowUpMode());
  await appConfig.clearLegacyFollowUpMode();
  sessions = new AgentSessionController(sessionRepository, appConfig, makeAdapter,
    (event) => mainWindow?.webContents.send("selfme:run-event", event),
    join(root, "runtime-homes"), (sessionId, queue) => mainWindow?.webContents.send("selfme:agent-queue-change", { sessionId, queue }));
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
    return Promise.all(agentRuntimeIds.map((runtimeId) => makeAdapter(runtimeId, "probe").probe()));
  });
  ipcMain.handle("selfme:get-provider-status", async (event, runtimeId: string) => {
    assertMainWindow(event);
    if (runtimeId === "dsh") return getDshProviderStatus();
    if (runtimeId === "codex") return getCodexProviderStatus();
    if (runtimeId === "pi") return getPiProviderStatus();
    if (runtimeId === "kimi-code") return getKimiProviderStatus();
    if (runtimeId === "qwen-code") return getQwenProviderStatus();
    if (runtimeId === "claude-code") return getClaudeProviderStatus();
    if (runtimeId === "jev") return getJevProviderStatus();
    throw new Error("此运行时暂不支持模型配置");
  });
  ipcMain.handle("selfme:list-provider-models", async (event, runtimeId: string, config: { baseUrl: string; apiKey?: string }) => {
    assertMainWindow(event);
    if (!isAgentRuntimeId(runtimeId) || !config || typeof config.baseUrl !== "string" || (config.apiKey !== undefined && typeof config.apiKey !== "string")) {
      throw new Error("无效的模型列表请求");
    }
    let apiKey = config.apiKey?.trim();
    const protocol = runtimeId === "claude-code" ? "anthropic" : "openai";
    if (!apiKey) {
      const saved = runtimeId === "dsh" ? await getDshProvider()
        : runtimeId === "codex" ? await getCodexProvider()
          : runtimeId === "pi" ? await getPiProvider()
            : runtimeId === "qwen-code" ? await getQwenProvider() : runtimeId === "claude-code" ? await getClaudeProvider() : await getKimiProvider();
      if (modelListUrl(config.baseUrl, protocol) !== modelListUrl(saved.baseUrl, protocol)) throw new Error("API 地址已更改，请先填写该地址的 API Key");
      apiKey = saved.apiKey;
    }
    return discoverModels(config.baseUrl, apiKey ?? "", protocol, net.fetch);
  });
  ipcMain.handle("selfme:save-provider", async (event, runtimeId: string, config: { baseUrl: string; apiKey?: string; model?: string }) => {
    assertMainWindow(event);
    if (runtimeId === "dsh") {
      return sessions!.reconfigure("dsh", () => saveDshProvider(config));
    }
    if (runtimeId === "codex") {
      return sessions!.reconfigure("codex", () => saveCodexProvider(config));
    }
    if (runtimeId === "pi") {
      return sessions!.reconfigure("pi", () => savePiProvider(config));
    }
    if (runtimeId === "kimi-code") {
      return sessions!.reconfigure("kimi-code", () => saveKimiProvider(config));
    }
    if (runtimeId === "qwen-code") {
      return sessions!.reconfigure("qwen-code", () => saveQwenProvider(config));
    }
    if (runtimeId === "claude-code") return sessions!.reconfigure("claude-code", () => saveClaudeProvider(config));
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
  ipcMain.handle("selfme:steer-session-prompt", async (event, sessionId: string, prompt: string) => {
    assertMainWindow(event);
    await sessions!.steer(sessionId, prompt);
  });
  ipcMain.handle("selfme:enqueue-session-prompt", async (event, sessionId: string, prompt: string) => {
    assertMainWindow(event); await sessions!.enqueue(sessionId, prompt);
  });
  ipcMain.handle("selfme:edit-queued-session-prompt", async (event, sessionId: string, messageId: string, prompt: string) => {
    assertMainWindow(event); await sessions!.editQueued(sessionId, messageId, prompt);
  });
  ipcMain.handle("selfme:delete-queued-session-prompt", async (event, sessionId: string, messageId: string) => {
    assertMainWindow(event); await sessions!.deleteQueued(sessionId, messageId);
  });
  ipcMain.handle("selfme:move-queued-session-prompt", async (event, sessionId: string, messageId: string, direction: "up" | "down") => {
    assertMainWindow(event); await sessions!.moveQueued(sessionId, messageId, direction);
  });
  ipcMain.handle("selfme:steer-queued-session-prompt", async (event, sessionId: string, messageId: string) => {
    assertMainWindow(event); await sessions!.steerQueued(sessionId, messageId);
  });
  ipcMain.handle("selfme:retry-queued-session-prompt", async (event, sessionId: string, messageId: string) => {
    assertMainWindow(event); await sessions!.retryQueued(sessionId, messageId);
  });
  ipcMain.handle("selfme:resume-session-queue", async (event, sessionId: string) => {
    assertMainWindow(event); await sessions!.resumeQueue(sessionId);
  });
  ipcMain.handle("selfme:pause-session-queue", (event, sessionId: string) => {
    assertMainWindow(event); sessions!.pauseQueue(sessionId);
  });
  ipcMain.handle("selfme:set-session-follow-up-mode", (event, sessionId: string, mode: FollowUpMode) => {
    assertMainWindow(event); sessions!.setFollowUpMode(sessionId, mode);
  });
  ipcMain.handle("selfme:respond-session-approval", async (event, sessionId: string, requestId: string | number, optionId: string, answers?: AgentQuestionAnswers) => {
    assertMainWindow(event);
    await sessions!.respondApproval(sessionId, requestId, optionId, answers);
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("SelfMe Lab 无法启动", `读取本地会话或配置失败：${message}`);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
