import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderStatus } from "../../../../packages/contracts/src/index";
import type { DshProvider } from "../../../../packages/runtime/src/dsh";

interface StoredProvider {
  baseUrl: string;
  encryptedApiKey?: string;
}

const defaultBaseUrl = "https://api.deepseek.com";

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
