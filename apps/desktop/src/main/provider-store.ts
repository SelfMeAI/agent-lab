import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderStatus } from "../../../../packages/contracts/src/index";
import type { CodexProvider } from "../../../../packages/runtime/src/codex";
import type { DshProvider } from "../../../../packages/runtime/src/dsh";

interface StoredProvider {
  baseUrl: string;
  encryptedApiKey?: string;
}

const defaultBaseUrl = "https://api.deepseek.com";
const defaultCodexBaseUrl = "https://api.openai.com/v1";
const defaultCodexModel = "gpt-5.6";

function providerPath(): string {
  return join(app.getPath("userData"), "dsh-provider.json");
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error("接口地址必须是 http(s) 根地址，且不能包含账户、查询或片段");
  }
  return url.toString().replace(/\/+$/u, "");
}

async function readProvider(): Promise<StoredProvider> {
  try {
    const value = JSON.parse(await readFile(providerPath(), "utf8")) as StoredProvider;
    return {
      baseUrl: normalizeBaseUrl(value.baseUrl),
      encryptedApiKey: typeof value.encryptedApiKey === "string" ? value.encryptedApiKey : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { baseUrl: defaultBaseUrl };
    throw error;
  }
}

export async function getDshProviderStatus(): Promise<ProviderStatus> {
  const stored = await readProvider();
  return {
    baseUrl: stored.baseUrl,
    configured: Boolean(stored.encryptedApiKey || process.env.DEEPSEEK_API_KEY?.trim()),
  };
}

export async function getDshProvider(): Promise<DshProvider> {
  const stored = await readProvider();
  const encrypted = stored.encryptedApiKey;
  if (!encrypted) return { baseUrl: stored.baseUrl, apiKey: process.env.DEEPSEEK_API_KEY?.trim() };
  const result = await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"));
  return { baseUrl: stored.baseUrl, apiKey: result.result };
}

export async function saveDshProvider(input: { baseUrl: string; apiKey?: string }): Promise<ProviderStatus> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const previous = await readProvider();
  const apiKey = input.apiKey?.trim();
  let encryptedApiKey = previous.encryptedApiKey;
  if (apiKey) {
    if (apiKey.length > 4096 || /[\r\n\0]/u.test(apiKey)) throw new Error("API Key 格式无效");
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("系统凭据加密暂不可用，未保存 API Key");
    encryptedApiKey = (await safeStorage.encryptStringAsync(apiKey)).toString("base64");
  }
  if (!encryptedApiKey && !process.env.DEEPSEEK_API_KEY?.trim()) throw new Error("请填写 API Key");
  const path = providerPath();
  await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ baseUrl, encryptedApiKey } satisfies StoredProvider), { mode: 0o600 });
  await rename(temporary, path);
  return { baseUrl, configured: true };
}

interface StoredCodexProvider extends StoredProvider {
  model: string;
}

function codexProviderPath(): string {
  return join(app.getPath("userData"), "codex-provider.json");
}

function normalizeCodexModel(value: string): string {
  const model = value.trim();
  if (!model || model.length > 256 || /[\r\n\0]/u.test(model)) throw new Error("Codex 模型 ID 格式无效");
  return model;
}

async function readCodexProvider(): Promise<StoredCodexProvider> {
  try {
    const value = JSON.parse(await readFile(codexProviderPath(), "utf8")) as StoredCodexProvider;
    return {
      baseUrl: normalizeBaseUrl(value.baseUrl),
      model: normalizeCodexModel(value.model),
      encryptedApiKey: typeof value.encryptedApiKey === "string" ? value.encryptedApiKey : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { baseUrl: defaultCodexBaseUrl, model: defaultCodexModel };
    throw error;
  }
}

export async function getCodexProviderStatus(): Promise<ProviderStatus> {
  const stored = await readCodexProvider();
  return { baseUrl: stored.baseUrl, model: stored.model, configured: Boolean(stored.encryptedApiKey) };
}

export async function getCodexProvider(): Promise<CodexProvider> {
  const stored = await readCodexProvider();
  if (!stored.encryptedApiKey) throw new Error("请先配置 Codex 模型 API Key");
  const result = await safeStorage.decryptStringAsync(Buffer.from(stored.encryptedApiKey, "base64"));
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey: result.result };
}

export async function saveCodexProvider(input: { baseUrl: string; model?: string; apiKey?: string }): Promise<ProviderStatus> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const previous = await readCodexProvider();
  const model = normalizeCodexModel(input.model ?? previous.model);
  const apiKey = input.apiKey?.trim();
  let encryptedApiKey = previous.encryptedApiKey;
  if (apiKey) {
    if (apiKey.length > 4096 || /[\r\n\0]/u.test(apiKey)) throw new Error("API Key 格式无效");
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("系统凭据加密暂不可用，未保存 API Key");
    encryptedApiKey = (await safeStorage.encryptStringAsync(apiKey)).toString("base64");
  }
  if (!encryptedApiKey) throw new Error("请填写 Codex API Key");
  const path = codexProviderPath();
  await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ baseUrl, model, encryptedApiKey } satisfies StoredCodexProvider), { mode: 0o600 });
  await rename(temporary, path);
  return { baseUrl, model, configured: true };
}

export async function importLegacyCodexProvider(directory: string): Promise<ProviderStatus> {
  const settings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8")) as { baseUrl?: unknown; model?: unknown };
  const credentials = JSON.parse(await readFile(join(directory, "credentials.json"), "utf8")) as { apiKey?: unknown };
  if (typeof settings.baseUrl !== "string" || typeof settings.model !== "string" || typeof credentials.apiKey !== "string") {
    throw new Error("旧版 Codex 设置文件缺少必要字段");
  }
  return saveCodexProvider({ baseUrl: settings.baseUrl, model: settings.model, apiKey: credentials.apiKey });
}

interface StoredJevProvider extends StoredProvider {
  model: string;
}

const defaultJevBaseUrl = "https://api.typesafe.ai";
const defaultJevModel = "jev-latest";

function jevProviderPath(): string {
  return join(app.getPath("userData"), "jev-provider.json");
}

async function readJevProvider(): Promise<StoredJevProvider> {
  try {
    const value = JSON.parse(await readFile(jevProviderPath(), "utf8")) as StoredJevProvider;
    return {
      baseUrl: normalizeBaseUrl(value.baseUrl),
      model: normalizeCodexModel(value.model),
      encryptedApiKey: typeof value.encryptedApiKey === "string" ? value.encryptedApiKey : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { baseUrl: defaultJevBaseUrl, model: defaultJevModel };
    throw error;
  }
}

export async function getJevProviderStatus(): Promise<ProviderStatus> {
  const stored = await readJevProvider();
  return { baseUrl: stored.baseUrl, model: stored.model, configured: Boolean(stored.encryptedApiKey) };
}

export async function getJevProvider(): Promise<{ baseUrl: string; model: string; apiKey?: string }> {
  const stored = await readJevProvider();
  if (!stored.encryptedApiKey) return { baseUrl: stored.baseUrl, model: stored.model };
  const result = await safeStorage.decryptStringAsync(Buffer.from(stored.encryptedApiKey, "base64"));
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey: result.result };
}

export async function saveJevProvider(input: { baseUrl: string; model?: string; apiKey?: string }): Promise<ProviderStatus> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const previous = await readJevProvider();
  const model = normalizeCodexModel(input.model ?? previous.model);
  const apiKey = input.apiKey?.trim();
  let encryptedApiKey = previous.encryptedApiKey;
  if (apiKey) {
    if (apiKey.length > 4096 || /[\r\n\0]/u.test(apiKey)) throw new Error("API Key 格式无效");
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("系统凭据加密暂不可用，未保存 API Key");
    encryptedApiKey = (await safeStorage.encryptStringAsync(apiKey)).toString("base64");
  }
  if (!encryptedApiKey) throw new Error("请填写 JEV API Key");
  const path = jevProviderPath();
  await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ baseUrl, model, encryptedApiKey } satisfies StoredJevProvider), { mode: 0o600 });
  await rename(temporary, path);
  return { baseUrl, model, configured: true };
}

export async function importLegacyJevProvider(filePath: string): Promise<ProviderStatus> {
  const contents = await readFile(filePath, "utf8");
  const raw = contents.split(/\r?\n/u).find((line) => line.startsWith("TYPESAFE_API_KEY="))?.slice("TYPESAFE_API_KEY=".length).trim();
  const apiKey = raw?.replace(/^(?:"|')|(?:"|')$/gu, "");
  if (!apiKey) throw new Error("文件中未找到 TYPESAFE_API_KEY");
  return saveJevProvider({ baseUrl: defaultJevBaseUrl, model: defaultJevModel, apiKey });
}
