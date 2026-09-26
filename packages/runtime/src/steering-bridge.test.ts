import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
describe("version-pinned ACP extensions", () => {
  it.each([
    ["dsh", "@deepseek-ai/dsh-acp/lib/index.js", "transformDsh"],
    ["kimi-code", "@moonshot-ai/kimi-code/dist/main.mjs", "transformKimi"],
  ])("%s fails closed on an upstream change instead of silently queueing a new task", async (runtime, entry, exportName) => {
    const module = await import(pathToFileURL(join(root, "runtimes", runtime, "steering-loader.mjs")).href);
    const source = await readFile(join(root, "runtimes", runtime, "node_modules", entry), "utf8");
    const patched = module[exportName](source) as string;
    expect(patched).toContain('onRequest("_selfme/steer"');
    expect(patched).toContain("selfmeSteer(params)");
    if (runtime === "kimi-code") expect(patched).toContain("driver.cancelRequested = true;\n\t\t\tconst turnId = driver.turnId;");
    expect(() => module[exportName](source.replace("selfmeSteer", "changed").replace(".onNotification(methods.agent.session.cancel,", ".onNotification(changed,"))).toThrow(/signature changed/);
    expect(() => module[exportName](patched)).toThrow(/signature changed/);
  });
});
