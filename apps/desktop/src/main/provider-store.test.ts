import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  getDshProvider, getDshProviderStatus, getPiProvider, getPiProviderStatus,
  saveDshProvider, savePiProvider,
} from "./provider-store";

afterEach(async () => {
  if (state.userData) await rm(state.userData, { recursive: true, force: true });
  state.userData = "";
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
