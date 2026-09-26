import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KimiAdapter } from "./kimi";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entryPoint = join(root, "runtimes/kimi-code/node_modules/@moonshot-ai/kimi-code/dist/main.mjs");

describe("bundled Kimi Code ACP", () => {
  it.skipIf(!existsSync(entryPoint))("starts the official JS runtime with the steering bridge without a global Kimi install", async () => {
    await mkdir(join(root, ".work"), { recursive: true });
    const temporary = await mkdtemp(join(root, ".work/kimi-acp-smoke-"));
    const homeDirectory = join(temporary, "home");
    const workspace = join(temporary, "workspace");
    await mkdir(workspace, { recursive: true });
    const adapter = new KimiAdapter({
      entryPoint, nodeExecutable: process.execPath, steeringLoader: join(root, "runtimes/kimi-code/steering-loader.mjs"),
      homeDirectory,
      provider: async () => ({ baseUrl: "http://127.0.0.1:9/v1", model: "test-model", apiKey: "sk-local-test" }),
    });
    const phases: string[] = [];
    const titles: string[] = [];
    adapter.onEvent((event) => {
      if (event.phase) phases.push(event.phase);
      if (event.title) titles.push(event.title);
    });
    try {
      expect((await adapter.probe()).availability).toBe("ready");
      await adapter.start(workspace);
      expect(phases).toContain("ready");
      expect(titles).not.toContain("available_commands_update");
    } finally {
      await adapter.stop();
      await rm(temporary, { recursive: true, force: true });
    }
  }, 35000);
});
