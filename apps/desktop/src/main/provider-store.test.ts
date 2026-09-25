import { mkdtemp, rm } from "node:fs/promises";
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
  getDshProvider, getPiProvider, getPiProviderStatus,
  saveDshProvider, savePiProvider,
} from "./provider-store";

afterEach(async () => {
  if (state.userData) await rm(state.userData, { recursive: true, force: true });
  state.userData = "";
});

describe("Pi provider configuration", () => {
  it("copies DSH credentials once, then keeps both providers independent", async () => {
    state.userData = await mkdtemp(join(tmpdir(), "selfme-pi-provider-"));
    await saveDshProvider({ baseUrl: "https://first.example/v1", apiKey: "dsh-original" });

    expect(await getPiProviderStatus()).toEqual({ baseUrl: "https://first.example/v1", model: "deepseek-v4-pro", configured: true });
    expect(await getPiProvider()).toEqual({ baseUrl: "https://first.example/v1", model: "deepseek-v4-pro", apiKey: "dsh-original" });

    await saveDshProvider({ baseUrl: "https://second.example/v1", apiKey: "dsh-updated" });
    expect(await getPiProvider()).toEqual({ baseUrl: "https://first.example/v1", model: "deepseek-v4-pro", apiKey: "dsh-original" });

    await savePiProvider({ baseUrl: "https://third.example/v1", model: "custom-model", apiKey: "pi-updated" });
    expect(await getDshProvider()).toEqual({ baseUrl: "https://second.example/v1", apiKey: "dsh-updated" });
    expect(await getPiProvider()).toEqual({ baseUrl: "https://third.example/v1", model: "custom-model", apiKey: "pi-updated" });
  });
});
