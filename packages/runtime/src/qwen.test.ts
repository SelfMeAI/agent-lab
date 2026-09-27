import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QwenAdapter } from "./qwen";
import type { AcpAdapterOptions } from "./acp";

const root = fileURLToPath(new URL("../../../", import.meta.url));
describe("bundled Qwen Code ACP", () => {
  it("restores only the approved file-edit mode, without turning project command rules into a session-wide bypass", async () => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/qwen-permission-options-"));
    const records = new Map<string, unknown>();
    const options = { entryPoint: "unused", nodeExecutable: "unused", homeDirectory: scratch,
      provider: async () => ({ baseUrl: "http://127.0.0.1:9/v1", model: "deepseek-v4-flash", apiKey: "local-test-key" }),
      permissions: { get: (key: string) => records.get(key), set: (key: string, value: unknown) => { records.set(key, value); } } };
    const nativeOptions = (adapter: QwenAdapter) => (adapter as unknown as { options: AcpAdapterOptions }).options;
    try {
      const first = nativeOptions(new QwenAdapter(options));
      expect((await first.launch("/workspace")).args).toContain("default");
      first.rememberPermission!({ optionId: "proceed_always_project", name: "Always Allow in project", kind: "allow_always" });
      expect(records.size).toBe(0);
      first.rememberPermission!({ optionId: "proceed_always", name: "Allow All Edits", kind: "allow_always" });
      expect((await nativeOptions(new QwenAdapter(options)).launch("/workspace")).args).toContain("auto-edit");
      expect((await nativeOptions(new QwenAdapter(options)).launch("/other")).args).toContain("default");
      expect((await readFile(join(scratch, "settings.json"), "utf8"))).not.toContain("local-test-key");
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
  it("starts the official JS runtime without a global install or credential in settings", async () => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/qwen-smoke-"));
    const workspace = join(scratch, "workspace");
    const homeDirectory = join(scratch, "home");
    await mkdir(workspace);
    const adapter = new QwenAdapter({
      entryPoint: join(root, "runtimes/qwen-code/node_modules/@qwen-code/qwen-code/cli-entry.js"),
      nodeExecutable: process.execPath, homeDirectory,
      provider: async () => ({ baseUrl: "http://127.0.0.1:9/v1", model: "deepseek-v4-flash", apiKey: "sk-local-qwen-check" }),
    });
    try {
      expect((await adapter.probe()).availability).toBe("ready");
      await adapter.start(workspace);
      expect(adapter.getResumeRef()).toBeTruthy();
      expect(await readFile(join(homeDirectory, "settings.json"), "utf8")).not.toContain("sk-local-qwen-check");
      const ref = adapter.getResumeRef()!;
      await adapter.stop();
      // Like Codex, a brand-new Qwen session is not persisted until input.
      // The controller must start it fresh rather than resume a missing record.
      await adapter.start(workspace);
      expect(adapter.getResumeRef()).not.toBe(ref);
    } finally { await adapter.stop(); await rm(scratch, { recursive: true, force: true }); }
  }, 35000);
});
