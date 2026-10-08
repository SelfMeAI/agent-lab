import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LocalModelStore, defaultLocalModelParameters, validateLocalModelParameters } from "./local-model-store";
import type { LocalModelDownload, LocalModelRun } from "../../../../packages/contracts/src/local-model";
const roots: string[] = []; const stores: LocalModelStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function prepare(): Promise<LocalModelStore> {
  const parent = fileURLToPath(new URL("../../../../.work/local-model-tests", import.meta.url)); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "storage-")); roots.push(root);
  const store = new LocalModelStore(root); stores.push(store); await store.init(); return store;
}
export function fixtureRun(): LocalModelRun {
  return { id: "run-fixture", mode: "playground", prompt: "请回答问题", systemPrompt: "中文", parameters: { ...defaultLocalModelParameters }, createdAt: new Date().toISOString(), completedAt: null, status: "running",
    outputs: [{ model: "qwen3:0.6b", digest: "exact-digest", parameterSize: "0.6B", quantization: "Q4", status: "running", text: "部分输出", thinking: "保留思考", error: null,
      metrics: { firstOutputMs: 3, durationMs: null, loadMs: null, inputTokens: null, outputTokens: null, tokensPerSecond: null } }] };
}
describe("local model SQLite and configuration", () => {
  it("recovers interrupted downloads as paused, preserves bytes and separates model directories", async () => {
    const store = await prepare(); const root = roots.at(-1)!; const original = store.modelsDirectory;
    const download: LocalModelDownload = { model: "qwen3:0.6b", status: "downloading", message: "下载模型文件", completed: 100, total: 1000, error: null,
      startedAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:01.000Z", bytesPerSecond: 50, remainingSeconds: 18 };
    store.saveDownload(download); await store.close();
    const reopened = new LocalModelStore(root); stores.push(reopened); await reopened.init();
    expect(reopened.getDownload()).toMatchObject({ model: download.model, completed: 100, total: 1000, status: "paused", bytesPerSecond: null, remainingSeconds: null });
    const copy = reopened.getDownload()!; copy.completed = 900; expect(reopened.getDownload()!.completed).toBe(100);
    await reopened.setModelsDirectory(join(root, "different-models")); expect(reopened.getDownload()).toBeNull();
    await reopened.setModelsDirectory(original); expect(reopened.getDownload()!.completed).toBe(100);
    reopened.saveDownload({ ...download, status: "cancelling" }); await reopened.close(); await reopened.init();
    expect(reopened.getDownload()!.status).toBe("cancelled"); reopened.saveDownload(null); expect(reopened.getDownload()).toBeNull();
  });
  it("stores defaults in JSON, experiment evidence in SQLite and recovers partial work without rerunning", async () => {
    const store = await prepare(); const root = roots.at(-1)!;
    await store.savePreferences({ selectedModel: "qwen3:0.6b", modelA: "qwen3:0.6b", modelB: "gemma3:1b", parameters: { ...defaultLocalModelParameters, seed: 42 } });
    store.saveRun(fixtureRun()); await store.close();
    expect(JSON.parse(await readFile(join(root, "local-model-config.json"), "utf8"))).toMatchObject({ version: 1, preferences: { parameters: { seed: 42 } } });
    const reopened = new LocalModelStore(root); stores.push(reopened); await reopened.init();
    expect(reopened.preferences.modelB).toBe("gemma3:1b"); expect(reopened.latest()).toMatchObject({ status: "interrupted", outputs: [{ text: "部分输出", thinking: "保留思考", status: "interrupted", digest: "exact-digest" }] });
    expect(reopened.history()[0]).toMatchObject({ prompt: "请回答问题", models: ["qwen3:0.6b"], status: "interrupted" });
    const completedAt = reopened.latest()!.completedAt; await reopened.close(); await reopened.init(); expect(reopened.latest()!.completedAt).toBe(completedAt);
  });
  it("directory changes do not delete original models or experiments", async () => {
    const store = await prepare(); const original = store.modelsDirectory; const root = roots.at(-1)!;
    store.saveRun({ ...fixtureRun(), status: "complete" }); await store.setModelsDirectory(join(root, "other-models"));
    expect(store.getRun("run-fixture").outputs[0].digest).toBe("exact-digest"); expect(store.modelsDirectory).not.toBe(original);
    await store.setModelsDirectory(original); store.deleteRun("run-fixture"); expect(store.history()).toHaveLength(0);
    await expect(store.setModelsDirectory("relative")).rejects.toThrow();
  });
  it("validates parameters, protects defaults and serializes configuration writes", async () => {
    const store = await prepare(); const prefs = store.preferences; prefs.parameters.temperature = 2;
    expect(store.preferences.parameters.temperature).toBe(0.7);
    await Promise.all([0.1, 0.2, 0.3].map((temperature) => store.savePreferences({ ...store.preferences, parameters: { ...defaultLocalModelParameters, temperature } })));
    expect(JSON.parse(await readFile(join(roots.at(-1)!, "local-model-config.json"), "utf8")).preferences.parameters.temperature).toBe(0.3);
    for (const patch of [{ temperature: NaN }, { contextLength: 0 }, { maxTokens: 0 }, { seed: -1 }, { thinking: "fake" }]) expect(() => validateLocalModelParameters({ ...defaultLocalModelParameters, ...patch })).toThrow();
    await expect(store.savePreferences({ ...store.preferences, modelA: "../escape" })).rejects.toThrow();
  });
});
