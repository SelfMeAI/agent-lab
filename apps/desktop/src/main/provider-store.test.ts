import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(`test-encrypted:${value}`),
    decryptStringAsync: async (value: Buffer) => ({ result: value.toString().replace(/^test-encrypted:/u, "") }),
  },
}));

import {
  getDshProvider, getDshProviderStatus, getKimiProvider, getKimiProviderStatus, getPiProvider, getPiProviderStatus,
  saveDshProvider, saveKimiProvider, savePiProvider,
  getQwenProvider, getQwenProviderStatus, saveQwenProvider,
} from "./provider-store";

afterEach(async () => {
  if (state.userData) await rm(state.userData, { recursive: true, force: true });
  state.userData = "";
});

describe("Qwen Code independent provider configuration", () => {
  it("copies DSH once, encrypts the key, and supports independent edits and blank-key saves", async () => {
    state.userData = await mkdtemp(join(tmpdir(), "selfme-qwen-provider-"));
    await saveDshProvider({ baseUrl: "https://first.example/v1", model: "deepseek-v4-pro", apiKey: "initial-qwen-secret" });
    const statuses = await Promise.all([getQwenProviderStatus(), getQwenProviderStatus()]);
    expect(statuses[0]).toEqual({ baseUrl: "https://first.example/v1", model: "deepseek-v4-pro", configured: true });
    expect(statuses[1]).toEqual(statuses[0]);
    expect(await readFile(join(state.userData, "qwen-provider.json"), "utf8")).not.toContain("initial-qwen-secret");
    await saveDshProvider({ baseUrl: "https://changed.example/v1", apiKey: "changed-dsh-secret" });
    expect(await getQwenProvider()).toEqual({ baseUrl: "https://first.example/v1", model: "deepseek-v4-pro", apiKey: "initial-qwen-secret" });
    await saveQwenProvider({ baseUrl: "https://own.example/v1", model: "qwen-model", apiKey: "qwen-new-secret" });
    await saveQwenProvider({ baseUrl: "https://own.example/v1", model: "another-model", apiKey: "" });
    expect(await getQwenProvider()).toEqual({ baseUrl: "https://own.example/v1", model: "another-model", apiKey: "qwen-new-secret" });
    expect((await getDshProvider()).apiKey).toBe("changed-dsh-secret");
  });
  it("does not adopt later DSH edits after first initialization without a key", async () => {
    state.userData = await mkdtemp(join(tmpdir(), "selfme-qwen-provider-"));
    expect((await getQwenProviderStatus()).configured).toBe(false);
    await saveDshProvider({ baseUrl: "https://later.example/v1", apiKey: "later-key" });
    await expect(getQwenProvider()).rejects.toThrow("请先配置 Qwen Code");
  });
});

describe("Pi provider configuration", () => {
  it("does not copy DSH credentials for new users and keeps saved settings independent", async () => {
    state.userData = await mkdtemp(join(tmpdir(), "selfme-pi-provider-"));
    await saveDshProvider({ baseUrl: "https://first.example/v1", apiKey: "dsh-original" });
    expect(await getDshProviderStatus()).toEqual({ baseUrl: "https://first.example/v1", model: "deepseek-v4-flash", configured: true });

    expect(await getPiProviderStatus()).toEqual({ baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", configured: false });
    await expect(getPiProvider()).rejects.toThrow("请先配置 Pi 模型 API Key");

    await savePiProvider({ baseUrl: "https://first.example/v1", apiKey: "pi-original" });
    expect(await getPiProvider()).toEqual({ baseUrl: "https://first.example/v1", model: "deepseek-v4-pro", apiKey: "pi-original" });

    await saveDshProvider({ baseUrl: "https://second.example/v1", model: "gateway-model", apiKey: "dsh-updated" });
    expect(await getPiProvider()).toEqual({ baseUrl: "https://first.example/v1", model: "deepseek-v4-pro", apiKey: "pi-original" });

    await savePiProvider({ baseUrl: "https://third.example/v1", model: "custom-model", apiKey: "pi-updated" });
    expect(await getDshProvider()).toEqual({ baseUrl: "https://second.example/v1", model: "gateway-model", apiKey: "dsh-updated" });
    expect(await getPiProvider()).toEqual({ baseUrl: "https://third.example/v1", model: "custom-model", apiKey: "pi-updated" });
  });

  it("uses the bundled ACP model for an older DSH configuration without a model field", async () => {
    state.userData = await mkdtemp(join(tmpdir(), "selfme-dsh-provider-"));
    await writeFile(join(state.userData, "dsh-provider.json"), JSON.stringify({ baseUrl: "https://api.deepseek.com" }));
    expect(await getDshProviderStatus()).toEqual({ baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", configured: false });
  });
});

describe("Kimi provider configuration", () => {
  it("copies an existing DSH connection only on first use and then remains independent", async () => {
    state.userData = await mkdtemp(join(tmpdir(), "selfme-kimi-provider-"));
    await saveDshProvider({ baseUrl: "https://first.example/v1", model: "deepseek-v4-pro", apiKey: "dsh-original" });

    expect(await getKimiProvider()).toEqual({ baseUrl: "https://first.example/v1", model: "deepseek-v4-pro", apiKey: "dsh-original" });
    await saveDshProvider({ baseUrl: "https://second.example/v1", model: "new-model", apiKey: "dsh-updated" });
    expect(await getKimiProvider()).toEqual({ baseUrl: "https://first.example/v1", model: "deepseek-v4-pro", apiKey: "dsh-original" });

    await saveKimiProvider({ baseUrl: "https://third.example/v1", model: "kimi-model", apiKey: "kimi-key" });
    expect(await getKimiProvider()).toEqual({ baseUrl: "https://third.example/v1", model: "kimi-model", apiKey: "kimi-key" });
    expect(await getDshProvider()).toEqual({ baseUrl: "https://second.example/v1", model: "new-model", apiKey: "dsh-updated" });
  });

  it("starts with Kimi defaults when no DSH key exists", async () => {
    state.userData = await mkdtemp(join(tmpdir(), "selfme-kimi-provider-"));
    expect(await getKimiProviderStatus()).toEqual({ baseUrl: "https://api.kimi.com/coding/v1", model: "kimi-for-coding", configured: false });
    await saveDshProvider({ baseUrl: "https://later.example/v1", apiKey: "later-dsh-key" });
    expect(await getKimiProviderStatus()).toEqual({ baseUrl: "https://api.kimi.com/coding/v1", model: "kimi-for-coding", configured: false });
  });
});
