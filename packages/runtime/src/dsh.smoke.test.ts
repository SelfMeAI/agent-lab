import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DshAdapter } from "./dsh";

describe("bundled DSH ACP", () => {
  it.skipIf(!process.env.SELFME_DSH_SMOKE)("starts a real ACP session without a global Node or DSH install", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const homeDirectory = join(root, ".work", "dsh-acp-smoke-home");
    await mkdir(homeDirectory, { recursive: true });
    const adapter = new DshAdapter({
      entryPoint: process.env.SELFME_DSH_ENTRY_POINT ?? join(root, "runtimes", "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      homeDirectory,
      nodeExecutable: process.env.SELFME_DSH_NODE_EXECUTABLE ?? process.execPath,
      provider: async () => ({ baseUrl: "https://api.deepseek.com" }),
    });
    const events: string[] = [];
    adapter.onEvent((event) => { if (event.phase) events.push(event.phase); });
    try {
      await adapter.start(root);
      expect(events).toContain("ready");
      const failedPrompt = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("DSH 未返回缺少密钥的任务错误")), 15000);
        const unsubscribe = adapter.onEvent((event) => {
          if (event.kind !== "error") return;
          clearTimeout(timer);
          unsubscribe();
          resolve(event.text ?? "");
        });
      });
      await adapter.send("请回答：你好");
      expect(await failedPrompt).toMatch(/credential|API key|密钥|turn failed/iu);
    } finally {
      await adapter.stop();
    }
  }, 45000);
});
