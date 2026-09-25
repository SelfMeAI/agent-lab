import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderStatus } from "../../../../packages/contracts/src/index";
import type { CodexProvider } from "../../../../packages/runtime/src/codex";
import type { DshProvider } from "../../../../packages/runtime/src/dsh";
import type { KimiProvider } from "../../../../packages/runtime/src/kimi";
import type { PiProvider } from "../../../../packages/runtime/src/pi";

interface StoredProvider {
  baseUrl: string;
  encryptedApiKey?: string;
}

const defaultBaseUrl = "https://api.deepseek.com";
const defaultDshModel = "deepseek-v4-flash";
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

interface StoredDshProvider extends StoredProvider {
  model: string;
}

async function readProvider(): Promise<StoredDshProvider> {
  try {
    const value = JSON.parse(await readFile(providerPath(), "utf8")) as StoredProvider & { model?: string };
    return {
      baseUrl: normalizeBaseUrl(value.baseUrl),
      model: normalizeModel(value.model ?? defaultDshModel),
      encryptedApiKey: typeof value.encryptedApiKey === "string" ? value.encryptedApiKey : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { baseUrl: defaultBaseUrl, model: defaultDshModel };
    throw error;
  }
}

export async function getDshProviderStatus(): Promise<ProviderStatus> {
  const stored = await readProvider();
  return {
    baseUrl: stored.baseUrl,
    model: stored.model,
    configured: Boolean(stored.encryptedApiKey || process.env.DEEPSEEK_API_KEY?.trim()),
  };
}

export async function getDshProvider(): Promise<DshProvider> {
  const stored = await readProvider();
  const encrypted = stored.encryptedApiKey;
  if (!encrypted) return { baseUrl: stored.baseUrl, model: stored.model, apiKey: process.env.DEEPSEEK_API_KEY?.trim() };
  const result = await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"));
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey: result.result };
}

export async function saveDshProvider(input: { baseUrl: string; model?: string; apiKey?: string }): Promise<ProviderStatus> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const previous = await readProvider();
  const model = normalizeModel(input.model ?? previous.model);
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
  await writeFile(temporary, JSON.stringify({ baseUrl, model, encryptedApiKey } satisfies StoredDshProvider), { mode: 0o600 });
  await rename(temporary, path);
  return { baseUrl, model, configured: true };
}

interface StoredCodexProvider extends StoredProvider {
  model: string;
}

function codexProviderPath(): string {
  return join(app.getPath("userData"), "codex-provider.json");
}

function normalizeModel(value: string): string {
  const model = value.trim();
  if (!model || model.length > 256 || /[\r\n\0]/u.test(model)) throw new Error("模型 ID 格式无效");
  return model;
}

async function readCodexProvider(): Promise<StoredCodexProvider> {
  try {
    const value = JSON.parse(await readFile(codexProviderPath(), "utf8")) as StoredCodexProvider;
    return {
      baseUrl: normalizeBaseUrl(value.baseUrl),
      model: normalizeModel(value.model),
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
  const model = normalizeModel(input.model ?? previous.model);
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

interface StoredModelProvider extends StoredProvider {
  model: string;
}

const defaultPiModel = "deepseek-v4-pro";

function piProviderPath(): string {
  return join(app.getPath("userData"), "pi-provider.json");
}

async function readPiProvider(): Promise<StoredModelProvider> {
  try {
    const value = JSON.parse(await readFile(piProviderPath(), "utf8")) as StoredModelProvider;
    return {
      baseUrl: normalizeBaseUrl(value.baseUrl),
      model: normalizeModel(value.model),
      encryptedApiKey: typeof value.encryptedApiKey === "string" ? value.encryptedApiKey : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { baseUrl: defaultBaseUrl, model: defaultPiModel };
    throw error;
  }
}

async function writePiProvider(value: StoredModelProvider): Promise<void> {
  const path = piProviderPath();
  await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

export async function getPiProviderStatus(): Promise<ProviderStatus> {
  const stored = await readPiProvider();
  return { baseUrl: stored.baseUrl, model: stored.model, configured: Boolean(stored.encryptedApiKey) };
}

export async function getPiProvider(): Promise<PiProvider> {
  const stored = await readPiProvider();
  if (!stored.encryptedApiKey) throw new Error("请先配置 Pi 模型 API Key");
  const result = await safeStorage.decryptStringAsync(Buffer.from(stored.encryptedApiKey, "base64"));
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey: result.result };
}

export async function savePiProvider(input: { baseUrl: string; model?: string; apiKey?: string }): Promise<ProviderStatus> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const previous = await readPiProvider();
  const model = normalizeModel(input.model ?? previous.model);
  const apiKey = input.apiKey?.trim();
  let encryptedApiKey = previous.encryptedApiKey;
  if (apiKey) {
    if (apiKey.length > 4096 || /[\r\n\0]/u.test(apiKey)) throw new Error("API Key 格式无效");
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("系统凭据加密暂不可用，未保存 API Key");
    encryptedApiKey = (await safeStorage.encryptStringAsync(apiKey)).toString("base64");
  }
  if (!encryptedApiKey) throw new Error("请填写 Pi API Key");
  await writePiProvider({ baseUrl, model, encryptedApiKey });
  return { baseUrl, model, configured: true };
}

const defaultKimiBaseUrl = "https://api.kimi.com/coding/v1";
const defaultKimiModel = "kimi-for-coding";

function kimiProviderPath(): string {
  return join(app.getPath("userData"), "kimi-provider.json");
}

async function readKimiProvider(): Promise<StoredModelProvider> {
  try {
    const value = JSON.parse(await readFile(kimiProviderPath(), "utf8")) as StoredModelProvider;
    return {
      baseUrl: normalizeBaseUrl(value.baseUrl),
      model: normalizeModel(value.model),
      encryptedApiKey: typeof value.encryptedApiKey === "string" ? value.encryptedApiKey : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const dsh = await readProvider();
      if (dsh.encryptedApiKey) return dsh;
      return { baseUrl: defaultKimiBaseUrl, model: defaultKimiModel };
    }
    throw error;
  }
}

export async function getKimiProviderStatus(): Promise<ProviderStatus> {
  const stored = await readKimiProvider();
  return { baseUrl: stored.baseUrl, model: stored.model, configured: Boolean(stored.encryptedApiKey) };
}

export async function getKimiProvider(): Promise<KimiProvider> {
  const stored = await readKimiProvider();
  if (!stored.encryptedApiKey) throw new Error("请先配置 Kimi Code 模型 API Key");
  const result = await safeStorage.decryptStringAsync(Buffer.from(stored.encryptedApiKey, "base64"));
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey: result.result };
}

export async function saveKimiProvider(input: { baseUrl: string; model?: string; apiKey?: string }): Promise<ProviderStatus> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const previous = await readKimiProvider();
  const model = normalizeModel(input.model ?? previous.model);
  const apiKey = input.apiKey?.trim();
  let encryptedApiKey = previous.encryptedApiKey;
  if (apiKey) {
    if (apiKey.length > 4096 || /[\r\n\0]/u.test(apiKey)) throw new Error("API Key 格式无效");
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("系统凭据加密暂不可用，未保存 API Key");
    encryptedApiKey = (await safeStorage.encryptStringAsync(apiKey)).toString("base64");
  }
  if (!encryptedApiKey) throw new Error("请填写 Kimi Code API Key");
  const path = kimiProviderPath();
  await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ baseUrl, model, encryptedApiKey } satisfies StoredModelProvider), { mode: 0o600 });
  await rename(temporary, path);
  return { baseUrl, model, configured: true };
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
      model: normalizeModel(value.model),
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
  const model = normalizeModel(input.model ?? previous.model);
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
