import { app, BrowserWindow, dialog, ipcMain, Menu, net, safeStorage, session, shell, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { agentRuntimeIds, isAgentRuntimeId, type AgentQuestionAnswers, type AgentRuntimeId, type AppInfo, type FollowUpMode, type JevExperimentId } from "../../../../packages/contracts/src/index";
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
import { runJevExperiment } from "./jev-experiment";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";
import { AgentSessionController } from "./agent-session-controller";
import { installAppShutdown } from "./app-shutdown";
import { harnessNodeExecutable } from "./harness-node";
import { LocalModelStore } from "./local-model-store";
import { LocalModelService } from "./local-model-service";
import { electronModelMetadataFetch } from "./electron-model-network";
import type { LocalModelPreferences, LocalModelRunRequest } from "../../../../packages/contracts/src/local-model";
import { isRemoteAgentId, type RemoteAgentId, type RemoteModelInput, type RemoteModelListInput } from "../../../../packages/contracts/src/remote-agent";
import { RemoteModelClient } from "../../../../packages/remote-agent/src/model-connection";
import { RemoteServiceCredentials } from "./remote-agent/credentials";
import { RemoteAgentContainer } from "./remote-agent/service-manager";
import { RemoteDevelopmentService } from "./remote-agent/development-service";
import { RemoteTaskController } from "./remote-agent/task-controller";
import { remoteTaskId } from "../../../../packages/remote-agent/src/transport/http";
import type { RemoteCredentials } from "./remote-agent/credentials";
import { applicationIdentity, applicationName } from "./application-identity";
import { applicationMenuTemplate } from "./application-menu";
import { labOpenClawTaskId } from "../../../../packages/remote-agent/src/identity";
import { executableName, ollamaExecutableRelativePath } from "../../../../runtimes/platform.mjs";
import { encryptCredential } from "./credential-encryption";

let mainWindow: BrowserWindow | null = null;
let sessions: AgentSessionController | null = null;
let sessionRepository: AgentSessionRepository | null = null;
let localModels: LocalModelService | null = null;
let remoteTasks: RemoteTaskController | null = null;
const shutdown = installAppShutdown(app,
  async () => {
    // Closing the client detaches observers, not remote tasks/services.
    remoteTasks?.shutdown();
    const results = await Promise.allSettled([sessions?.stopAll(), localModels?.shutdown()]);
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "停止本地运行时失败");
  },
  () => sessionRepository?.close(),
  (error) => console.error("停止本地运行时失败：", error));

const identity = applicationIdentity(app.getPath("appData"));
// Electron captures the macOS Keychain service before ready. Existing installs
// retain that service; after ready all menus/windows use the current app name.
app.setName(identity.encryptionName);
app.setPath("userData", identity.root);
app.setPath("sessionData", identity.root);

function assertMainWindow(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Untrusted IPC sender");
  }
}

function createWindow(): void {
  if (shutdown.isQuitting()) return;
  const window = new BrowserWindow({
    title: "Agent Lab",
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 10, y: 19 } } : {}),
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#070b10",
    icon: app.isPackaged ? join(process.resourcesPath, "brand/agent-lab-app-icon.png") : join(__dirname, "../../../../assets/brand/agent-lab-app-icon.png"),
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
    remoteTasks?.shutdown();
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.on("render-process-gone", () => remoteTasks?.shutdown());
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
    executable: join(runtimeRoot, "codex", "bin", executableName("codex")),
    homeDirectory, provider: getCodexProvider, permissions,
  });
  if (runtimeId === "pi") return new PiAdapter({ homeDirectory, provider: getPiProvider, permissions });
  if (runtimeId === "claude-code") return new ClaudeAdapter({
    executable: join(runtimeRoot, "claude", "bin", executableName("claude")),
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
  app.setName(applicationName);
  app.setAboutPanelOptions({ applicationName, applicationVersion: app.getVersion() });
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(process.platform)));
  const root = app.getPath("userData");
  const appConfig = new AppConfigStore(root);
  await appConfig.init();
  sessionRepository = new AgentSessionRepository(root);
  await sessionRepository.init(appConfig.getLegacyFollowUpMode());
  await appConfig.clearLegacyFollowUpMode();
  const runtimeRoot = app.isPackaged ? process.resourcesPath : join(__dirname, "../../../../runtimes");
  localModels = new LocalModelService(new LocalModelStore(root), join(runtimeRoot, "ollama", ollamaExecutableRelativePath()),
    (event) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent-lab:local-model-event", event); }, undefined,
    () => session.defaultSession.resolveProxy("https://huggingface.co"), electronModelMetadataFetch);
  await localModels.init();
  sessions = new AgentSessionController(sessionRepository, appConfig, makeAdapter,
    (event) => mainWindow?.webContents.send("agent-lab:run-event", event),
    join(root, "runtime-homes"), (sessionId, queue) => mainWindow?.webContents.send("agent-lab:agent-queue-change", { sessionId, queue }));
  const remoteConnections = {} as Record<RemoteAgentId, { endpoint(): Promise<string>; credentials(): Promise<RemoteCredentials>; ensureDocumentPreview(): Promise<void> }>;
  const remoteServices = Object.fromEntries((["openhands", "openclaw"] as const).map(engine => {
    const credentials = new RemoteServiceCredentials(join(root, "remote-agent", "connections"), {
      encrypt: async (value) => encryptCredential(value, "系统凭据加密暂不可用，未创建服务凭据"),
      decrypt: async (value) => (await safeStorage.decryptStringAsync(value)).result,
    }, engine);
    const container = new RemoteAgentContainer(root, () => credentials.get(), engine);
    remoteConnections[engine] = { endpoint: () => container.requireEndpoint(), credentials: () => credentials.get(), ensureDocumentPreview: () => container.ensureDocumentPreview() };
    const model = new RemoteModelClient(engine, () => container.requireEndpoint(), () => credentials.get());
    return [engine, new RemoteDevelopmentService(container, model, async () => {
      const saved = await getDshProvider();
      return saved.apiKey ? { protocol: "openai", baseUrl: saved.baseUrl, model: saved.model, apiKey: saved.apiKey } : null;
    })];
  }));
  remoteTasks = new RemoteTaskController(remoteConnections, {
    choose: async () => { const result = await dialog.showOpenDialog(mainWindow!, { title: "上传文件到远端任务", properties: ["openFile", "multiSelections"] }); return result.canceled ? [] : result.filePaths; },
    save: async (name) => { const result = await dialog.showSaveDialog(mainWindow!, { title: "下载远端文件", defaultPath: name }); return result.canceled ? null : result.filePath ?? null; },
  }, event => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent-lab:remote-task-update", event); },
  event => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent-lab:remote-terminal-event", event); });
  const remote = (event: IpcMainInvokeEvent, engine: unknown) => {
    assertMainWindow(event);
    if (!isRemoteAgentId(engine)) throw new Error("未知远端智能体");
    return remoteServices[engine];
  };
  ipcMain.handle("agent-lab:remote-service-state", (event, engine) => remote(event, engine).state());
  ipcMain.handle("agent-lab:remote-service-control", async (event, engine, action) => {
    const service = remote(event, engine);
    if (!["start", "stop", "restart"].includes(action)) throw new Error("未知服务操作");
    remoteTasks!.reset(engine);
    return service.control(action);
  });
  ipcMain.handle("agent-lab:remote-service-logs", (event, engine) => remote(event, engine).logs());
  ipcMain.handle("agent-lab:remote-model-get", (event, engine) => remote(event, engine).getModel());
  ipcMain.handle("agent-lab:remote-model-save", (event, engine, input: RemoteModelInput) => remote(event, engine).saveModel(input));
  ipcMain.handle("agent-lab:remote-model-list", (event, engine, input: RemoteModelListInput) => remote(event, engine).listModels(input));
  const taskClient = (event: IpcMainInvokeEvent, engine: unknown, id?: unknown) => {
    remote(event, engine);
    if (id !== undefined && (typeof id !== "string" || (engine === "openhands" ? remoteTaskId(id) !== id : !labOpenClawTaskId(id)))) throw new Error("任务标识无效");
    return remoteTasks!.client(engine as RemoteAgentId);
  };
  ipcMain.handle("agent-lab:remote-task-list", (event, engine) => taskClient(event, engine).list());
  ipcMain.handle("agent-lab:remote-task-create", (event, engine) => taskClient(event, engine).create());
  ipcMain.handle("agent-lab:remote-task-open", (event, engine, id) => taskClient(event, engine, id).open(id));
  ipcMain.handle("agent-lab:remote-task-earlier", (event, engine, id) => { taskClient(event, engine, id); return remoteTasks!.earlier(engine, id); });
  ipcMain.handle("agent-lab:remote-task-close", (event, engine, id) => { taskClient(event, engine, id); return remoteTasks!.close(engine, id); });
  ipcMain.handle("agent-lab:remote-task-delete", async (event, engine, id) => {
    taskClient(event, engine, id);
    const result = await dialog.showMessageBox(mainWindow!, { type: "warning", title: "删除远端任务", message: "删除此任务及其对话记录？", detail: "这会删除服务端任务历史和待发消息。已生成文件仍留在服务卷中，工作中的任务将先停止。", buttons: ["取消", "删除任务"], defaultId: 0, cancelId: 0 });
    if (result.response === 1) await remoteTasks!.delete(engine, id);
  });
  ipcMain.handle("agent-lab:remote-task-send", (event, engine, id, prompt, files, options) => { taskClient(event, engine, id); return remoteTasks!.send(engine, id, prompt, files, options); });
  ipcMain.handle("agent-lab:remote-inputs-state", (event, engine, id) => taskClient(event, engine, id).inputQueue(id));
  ipcMain.handle("agent-lab:remote-inputs-mode", (event, engine, id, mode) => { if (mode !== "queue" && mode !== "steer") throw new Error("发送方式无效"); return taskClient(event, engine, id).inputMode(id, mode); });
  ipcMain.handle("agent-lab:remote-inputs-remove", (event, engine, id, messageId) => { if (typeof messageId !== "string") throw new Error("消息标识无效"); return taskClient(event, engine, id).inputAction(id, messageId, "remove"); });
  ipcMain.handle("agent-lab:remote-inputs-steer", (event, engine, id, messageId) => { if (typeof messageId !== "string") throw new Error("消息标识无效"); return taskClient(event, engine, id).inputAction(id, messageId, "steer"); });
  ipcMain.handle("agent-lab:remote-task-control", (event, engine, id, action) => { const client = taskClient(event, engine, id); if (action !== "stop" && action !== "resume") throw new Error("未知任务操作"); return client.control(id, action); });
  ipcMain.handle("agent-lab:remote-task-approval", (event, engine, id, requestId, decision) => {
    taskClient(event, engine, id); if (typeof requestId !== "string" || !["once", "always", "reject"].includes(decision)) throw new Error("审批无效");
    return engine === "openhands" ? remoteTasks!.hands.approve(id, requestId, decision) : remoteTasks!.claw.approve(id, requestId, decision);
  });
  ipcMain.handle("agent-lab:remote-task-question", (event, engine, id, requestId, answers) => {
    taskClient(event, engine, id); if (engine !== "openclaw") throw new Error("此引擎通过对话询问用户");
    if (typeof requestId !== "string" || (answers !== null && (!answers || typeof answers !== "object" || Object.values(answers).some(value => !Array.isArray(value) || value.some(answer => typeof answer !== "string" || answer.length > 10_000))))) throw new Error("回答无效");
    return remoteTasks!.claw.answer(id, requestId, answers);
  });
  ipcMain.handle("agent-lab:remote-task-upload", (event, engine, id, remaining = 10) => { taskClient(event, engine, id); return remoteTasks!.upload(engine, id, remaining); });
  ipcMain.handle("agent-lab:remote-task-files", (event, engine, id, path) => taskClient(event, engine, id).http.listFiles(id, path));
  ipcMain.handle("agent-lab:remote-task-preview", (event, engine, id, path) => { taskClient(event, engine, id); return remoteTasks!.preview(engine, id, path); });
  ipcMain.handle("agent-lab:remote-task-download", (event, engine, id, path) => { taskClient(event, engine, id); return remoteTasks!.download(engine, id, path); });
  ipcMain.handle("agent-lab:remote-task-desktop", (event, engine, id) => { taskClient(event, engine, id); return remoteTasks!.desktop(engine, id); });
  ipcMain.handle("agent-lab:remote-terminal-access", (event, engine, id) => { taskClient(event, engine, id); if (engine !== "openclaw") throw new Error("此引擎未接入交互终端"); return remoteTasks!.claw.terminalAccess(id); });
  const terminalClient = (event: IpcMainInvokeEvent, engine: unknown, id: unknown) => { taskClient(event, engine, id); if (engine !== "openclaw") throw new Error("此引擎未接入交互终端"); return remoteTasks!.claw; };
  ipcMain.handle("agent-lab:remote-terminal-open", (event, engine, id) => terminalClient(event, engine, id).terminal(id));
  ipcMain.handle("agent-lab:remote-terminal-input", (event, engine, id, terminalId, data) => { const client = terminalClient(event, engine, id); if (typeof data !== "string" || data.length > 65_536) throw new Error("终端输入无效"); return client.terminalInput(id, terminalId, data); });
  ipcMain.handle("agent-lab:remote-terminal-resize", (event, engine, id, terminalId, cols, rows) => { const client = terminalClient(event, engine, id); if (![cols, rows].every(value => Number.isInteger(value) && value >= 2 && value <= 500)) throw new Error("终端尺寸无效"); return client.terminalResize(id, terminalId, cols, rows); });
  ipcMain.handle("agent-lab:remote-terminal-close", (event, engine, id, terminalId) => terminalClient(event, engine, id).terminalClose(id, terminalId));
  ipcMain.handle("agent-lab:app-info", (event): AppInfo => {
    assertMainWindow(event);
    return { name: app.getName(), version: app.getVersion(), platform: process.platform, arch: process.arch };
  });
  ipcMain.handle("agent-lab:open-external", async (event, value: string): Promise<void> => {
    assertMainWindow(event);
    const url = new URL(value);
    const allowed = new Set(["developers.openai.com", "modelcontextprotocol.io", "github.com", "code.claude.com", "learn.microsoft.com", "support.google.com", "deepmind.google", "docs.langchain.com"]);
    if (url.protocol !== "https:" || !allowed.has(url.hostname) || url.username || url.password) throw new Error("不允许打开此外部地址");
    await shell.openExternal(url.toString());
  });
  ipcMain.handle("agent-lab:choose-workspace", async (event): Promise<string | null> => {
    assertMainWindow(event);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "选择工作目录",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("agent-lab:list-runtimes", async (event) => {
    assertMainWindow(event);
    return Promise.all(agentRuntimeIds.map((runtimeId) => makeAdapter(runtimeId, "probe").probe()));
  });
  ipcMain.handle("agent-lab:get-provider-status", async (event, runtimeId: string) => {
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
  ipcMain.handle("agent-lab:list-provider-models", async (event, runtimeId: string, config: { baseUrl: string; apiKey?: string }) => {
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
  ipcMain.handle("agent-lab:save-provider", async (event, runtimeId: string, config: { baseUrl: string; apiKey?: string; model?: string }) => {
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
  ipcMain.handle("agent-lab:jev-decision", async (event, fen: string, style: "balanced" | "aggressive" | "positional") => {
    assertMainWindow(event);
    return decideJevMove(fen, style);
  });
  ipcMain.handle("agent-lab:jev-experiment", async (event, experimentId: JevExperimentId, state: string) => {
    assertMainWindow(event);
    return runJevExperiment(experimentId, state);
  });
  ipcMain.handle("agent-lab:local-model-state", (event) => { assertMainWindow(event); return localModels!.getState(); });
  ipcMain.handle("agent-lab:local-model-details", (event, model: string) => { assertMainWindow(event); return localModels!.details(model); });
  ipcMain.handle("agent-lab:local-model-preferences", (event, value: LocalModelPreferences) => { assertMainWindow(event); return localModels!.savePreferences(value); });
  ipcMain.handle("agent-lab:local-model-run", (event, value: LocalModelRunRequest) => { assertMainWindow(event); return localModels!.startRun(value); });
  ipcMain.handle("agent-lab:local-model-stop", (event) => { assertMainWindow(event); localModels!.stopRun(); });
  ipcMain.handle("agent-lab:local-model-pull", (event, model: string) => { assertMainWindow(event); return localModels!.pull(model); });
  ipcMain.handle("agent-lab:local-model-pause-download", (event) => { assertMainWindow(event); return localModels!.pauseDownload(); });
  ipcMain.handle("agent-lab:local-model-resume-download", (event) => { assertMainWindow(event); return localModels!.resumeDownload(); });
  ipcMain.handle("agent-lab:local-model-stop-download", (event) => { assertMainWindow(event); return localModels!.stopDownload(); });
  ipcMain.handle("agent-lab:local-model-unload", (event, model: string) => { assertMainWindow(event); return localModels!.unload(model); });
  ipcMain.handle("agent-lab:local-model-delete", (event, model: string) => { assertMainWindow(event); return localModels!.deleteModel(model); });
  ipcMain.handle("agent-lab:local-model-history-run", (event, id: string) => { assertMainWindow(event); return localModels!.getRun(id); });
  ipcMain.handle("agent-lab:local-model-latest-run", (event, mode: LocalModelRunRequest["mode"], models: string[]) => { assertMainWindow(event); return localModels!.store.latestForModels(mode, models); });
  ipcMain.handle("agent-lab:local-model-delete-run", (event, id: string) => { assertMainWindow(event); localModels!.deleteRun(id); });
  ipcMain.handle("agent-lab:local-model-choose-directory", async (event): Promise<string | null> => {
    assertMainWindow(event);
    const result = await dialog.showOpenDialog(mainWindow!, { title: "选择模型存储目录", defaultPath: localModels!.store.modelsDirectory, properties: ["openDirectory", "createDirectory"] });
    const path = result.canceled ? null : result.filePaths[0] ?? null;
    if (path) await localModels!.changeDirectory(path);
    return path;
  });
  ipcMain.handle("agent-lab:local-model-open-directory", async (event): Promise<void> => {
    assertMainWindow(event); const error = await shell.openPath(localModels!.store.modelsDirectory); if (error) throw new Error(error);
  });
  ipcMain.handle("agent-lab:agent-session-catalog", async (event, runtimeId: AgentRuntimeId) => {
    assertMainWindow(event);
    return sessions!.catalog(runtimeId);
  });
  ipcMain.handle("agent-lab:create-agent-session", async (event, runtimeId: AgentRuntimeId, workspace: string) => {
    assertMainWindow(event);
    return sessions!.create(runtimeId, workspace);
  });
  ipcMain.handle("agent-lab:agent-session-events", async (event, sessionId: string) => {
    assertMainWindow(event);
    return sessions!.events(sessionId);
  });
  ipcMain.handle("agent-lab:select-agent-session", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.select(sessionId);
  });
  ipcMain.handle("agent-lab:delete-agent-session", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.delete(sessionId);
  });
  ipcMain.handle("agent-lab:restore-agent-session", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.restore(sessionId);
  });
  ipcMain.handle("agent-lab:purge-agent-session", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.purge(sessionId);
  });
  ipcMain.handle("agent-lab:start-agent-session", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.activate(sessionId);
  });
  ipcMain.handle("agent-lab:send-session-prompt", async (event, sessionId: string, prompt: string) => {
    assertMainWindow(event);
    await sessions!.send(sessionId, prompt);
  });
  ipcMain.handle("agent-lab:cancel-session-run", async (event, sessionId: string) => {
    assertMainWindow(event);
    await sessions!.cancel(sessionId);
  });
  ipcMain.handle("agent-lab:steer-session-prompt", async (event, sessionId: string, prompt: string) => {
    assertMainWindow(event);
    await sessions!.steer(sessionId, prompt);
  });
  ipcMain.handle("agent-lab:enqueue-session-prompt", async (event, sessionId: string, prompt: string) => {
    assertMainWindow(event); await sessions!.enqueue(sessionId, prompt);
  });
  ipcMain.handle("agent-lab:edit-queued-session-prompt", async (event, sessionId: string, messageId: string, prompt: string) => {
    assertMainWindow(event); await sessions!.editQueued(sessionId, messageId, prompt);
  });
  ipcMain.handle("agent-lab:delete-queued-session-prompt", async (event, sessionId: string, messageId: string) => {
    assertMainWindow(event); await sessions!.deleteQueued(sessionId, messageId);
  });
  ipcMain.handle("agent-lab:move-queued-session-prompt", async (event, sessionId: string, messageId: string, direction: "up" | "down") => {
    assertMainWindow(event); await sessions!.moveQueued(sessionId, messageId, direction);
  });
  ipcMain.handle("agent-lab:steer-queued-session-prompt", async (event, sessionId: string, messageId: string) => {
    assertMainWindow(event); await sessions!.steerQueued(sessionId, messageId);
  });
  ipcMain.handle("agent-lab:retry-queued-session-prompt", async (event, sessionId: string, messageId: string) => {
    assertMainWindow(event); await sessions!.retryQueued(sessionId, messageId);
  });
  ipcMain.handle("agent-lab:resume-session-queue", async (event, sessionId: string) => {
    assertMainWindow(event); await sessions!.resumeQueue(sessionId);
  });
  ipcMain.handle("agent-lab:pause-session-queue", (event, sessionId: string) => {
    assertMainWindow(event); sessions!.pauseQueue(sessionId);
  });
  ipcMain.handle("agent-lab:set-session-follow-up-mode", (event, sessionId: string, mode: FollowUpMode) => {
    assertMainWindow(event); sessions!.setFollowUpMode(sessionId, mode);
  });
  ipcMain.handle("agent-lab:respond-session-approval", async (event, sessionId: string, requestId: string | number, optionId: string, answers?: AgentQuestionAnswers) => {
    assertMainWindow(event);
    await sessions!.respondApproval(sessionId, requestId, optionId, answers);
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("Agent Lab 无法启动", `读取本地会话或配置失败：${message}`);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
