import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LocalModelStore, defaultLocalModelParameters } from "./local-model-store";
import { LocalModelService } from "./local-model-service";
import type { LocalModelDownload } from "../../../../packages/contracts/src/local-model";
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

async function waitForRun(service: LocalModelService, id: string, status: "complete" | "stopped", timeout = 120000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const run = service.getRun(id);
    if (run.status === status) return;
    if (["error", "complete", "stopped", "interrupted"].includes(run.status)) throw new Error(`真实实验 ${run.status}: ${run.outputs.map((o) => o.error).filter(Boolean).join(" / ")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`真实实验等待超时：${id}`);
}

async function waitForDownload(service: LocalModelService): Promise<void> {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const state = await service.getState();
    if (state.download?.status === "complete") return;
    if (state.download?.status === "error" || state.download?.status === "cancelled" || state.download?.status === "paused") throw new Error(state.download.error ?? state.download.message);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("真实模型下载超时");
}

// Opt-in: real official runtime and network transfers. Lifecycle/GGUF tests use disposable
// project-owned directories; the comparison test retains the application's model weights.
describe.skipIf(process.env.RUN_OLLAMA_INTEGRATION !== "1")("packaged Ollama real-model path", () => {
  it("pauses and cancels a real transfer, retries cached bytes, restores after restart, infers, deletes and re-downloads", async () => {
    const parent = join(repositoryRoot, ".work/local-model-tests"); await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "lifecycle-"));
    const executable = process.env.OLLAMA_TEST_EXECUTABLE ?? join(repositoryRoot, "runtimes/ollama/native/ollama");
    const model = "smollm2:135m-instruct-q4_K_M";
    let latest: LocalModelDownload | null = null, resumed = false;
    const resumedProgress: number[] = [], deltas: string[] = [];
    const create = (): LocalModelService => new LocalModelService(new LocalModelStore(root), executable, (event) => {
      if (event.type === "download") {
        latest = event.download;
        if (resumed && event.download.message === "下载模型文件" && event.download.completed) resumedProgress.push(event.download.completed);
      }
      if (event.type === "run" && event.run.outputs[0].text) deltas.push(event.run.outputs[0].text);
    });
    let service = create();
    try {
      await service.init(); expect((await service.getState()).runtime.status).toBe("ready");
      await service.pull(model);
      await vi.waitFor(() => {
        if (latest?.status === "error") throw new Error(latest.error ?? latest.message);
        expect(latest?.completed).toBeGreaterThan(0);
      }, { timeout: 90000, interval: 50 });
      await service.pauseDownload();
      const paused = service.store.getDownload()!;
      expect(paused.status).toBe("paused"); expect(paused.completed).toBeGreaterThan(0); expect(paused.completed).toBeLessThan(paused.total!);
      const cache = await readdir(join(service.store.modelsDirectory, "blobs"));
      expect(cache.some((name) => name.includes("partial"))).toBe(true);
      console.log("REAL OLLAMA paused with native partial cache", { completed: paused.completed, total: paused.total });
      await service.stopDownload();
      expect(service.store.getDownload()).toMatchObject({ status: "cancelled", completed: paused.completed });
      expect(await readdir(join(service.store.modelsDirectory, "blobs"))).toEqual(cache);
      await service.pull(model);
      await vi.waitFor(() => {
        if (latest?.status === "error") throw new Error(latest.error ?? latest.message);
        expect(latest?.status).toBe("downloading"); expect(latest?.completed).toBeGreaterThanOrEqual(paused.completed!);
      }, { timeout: 90000, interval: 50 });
      await service.pauseDownload();
      const retried = service.store.getDownload()!;
      expect(retried.status).toBe("paused"); expect(retried.completed).toBeGreaterThanOrEqual(paused.completed!);
      console.log("REAL OLLAMA cancelled/retried native cache", { completed: retried.completed, total: retried.total });
      await service.shutdown(); service = create(); await service.init();
      expect(service.store.getDownload()).toMatchObject({ status: "paused", completed: retried.completed, startedAt: retried.startedAt });
      expect((await service.getState()).download?.status).toBe("paused");
      resumed = true; await service.resumeDownload(); await waitForDownload(service);
      expect(resumedProgress[0]).toBeGreaterThanOrEqual(retried.completed!);
      console.log("REAL OLLAMA resumed native progress", resumedProgress.slice(0, 3));
      expect((await service.getState()).models.some((item) => item.name === model)).toBe(true);
      const run = await service.startRun({ mode: "playground", models: [model], prompt: "What is 2 plus 3? Answer briefly.", systemPrompt: "", parameters: { ...defaultLocalModelParameters, maxTokens: 48, seed: 42, thinking: "off" } });
      await waitForRun(service, run.id, "complete");
      expect(service.getRun(run.id).outputs[0].text.length).toBeGreaterThan(0); expect(service.getRun(run.id).outputs[0].metrics.outputTokens).toBeGreaterThan(0); expect(deltas.length).toBeGreaterThan(1);
      await service.deleteModel(model);
      expect((await service.getState()).models.some((item) => item.name === model)).toBe(false);
      expect(service.store.getDownload()).toBeNull(); expect(service.getRun(run.id).status).toBe("complete");
      await service.pull(model); await waitForDownload(service);
      expect((await service.getState()).models.some((item) => item.name === model)).toBe(true);
      await service.shutdown(); service = create(); await service.init();
      expect(service.store.getDownload()?.status).toBe("complete"); expect(service.getRun(run.id).status).toBe("complete");
      console.log("REAL OLLAMA inference/delete/re-download/reopen verified");
    } finally { await service.shutdown(); await rm(root, { recursive: true, force: true }); }
  }, 900000);

  it.skipIf(process.env.RUN_HF_INTEGRATION !== "1")("downloads a public Hugging Face GGUF and runs it locally", async () => {
    const parent = join(repositoryRoot, ".work/local-model-tests"); await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, "hf-"));
    const service = new LocalModelService(new LocalModelStore(root), process.env.OLLAMA_TEST_EXECUTABLE ?? join(repositoryRoot, "runtimes/ollama/native/ollama"), () => {});
    try {
      await service.init(); await service.pull("hf.co/LiquidAI/LFM2.5-350M-GGUF:Q4_0"); await waitForDownload(service);
      const installed = (await service.getState()).models[0]; expect(installed.name.toLowerCase()).toContain("lfm2.5-350m-gguf");
      const run = await service.startRun({ mode: "playground", models: [installed.name], prompt: "What is 2 plus 3? Answer briefly.", systemPrompt: "", parameters: { ...defaultLocalModelParameters, maxTokens: 48, seed: 42, thinking: "off" } });
      await waitForRun(service, run.id, "complete"); expect(service.getRun(run.id).outputs[0].text.length).toBeGreaterThan(0);
      console.log("REAL HF GGUF download/inference verified", { model: installed.name, size: installed.size, text: service.getRun(run.id).outputs[0].text });
    } finally { await service.shutdown(); await rm(root, { recursive: true, force: true }); }
  }, 900000);

  it("downloads two models, streams independent experiments, compares, cancels, retries and reopens evidence", async () => {
    const parent = join(repositoryRoot, ".work/local-model-tests"); await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, "integration-"));
    const store = new LocalModelStore(root); const deltas: string[] = [];
    const service = new LocalModelService(store, process.env.OLLAMA_TEST_EXECUTABLE ?? join(repositoryRoot, "runtimes/ollama/native/ollama"), (event) => { if (event.type === "run" && event.run.outputs[0].text) deltas.push(event.run.outputs[0].text); });
    try {
      await service.init();
      await service.changeDirectory(join(homedir(), "Library/Application Support/SelfMe Lab/local-models"));
      const initial = await service.getState();
      if (initial.runtime.status !== "ready") throw new Error(initial.runtime.error ?? "Ollama failed to start");
      expect(initial.runtime).toMatchObject({ status: "ready", version: "0.35.0" });
      for (const model of ["qwen3:0.6b", "gemma3:1b"]) {
        console.log(`REAL OLLAMA pull ${model}`);
        await service.pull(model);
        await waitForDownload(service);
      }
      const parameters = { ...defaultLocalModelParameters, maxTokens: 160, thinking: "off" as const, seed: 42 };
      const single = await service.startRun({ mode: "playground", models: ["qwen3:0.6b"], prompt: "用中文回答：2 加 3 是几？只答一句。", systemPrompt: "", parameters });
      await waitForRun(service, single.id, "complete");
      const recorded = service.getRun(single.id); expect(recorded.outputs[0].text.length).toBeGreaterThan(0); expect(recorded.outputs[0].metrics.outputTokens).toBeGreaterThan(0); expect(deltas.length).toBeGreaterThan(1);
      console.log("REAL OLLAMA Playground", recorded.outputs[0].text, recorded.outputs[0].metrics);
      const comparison = await service.startRun({ mode: "compare", models: ["qwen3:0.6b", "gemma3:1b"], prompt: "用中文解释什么是 SQLite，最多两句话。", systemPrompt: "", parameters });
      await waitForRun(service, comparison.id, "complete");
      const pair = service.getRun(comparison.id); for (const output of pair.outputs) { expect(output.text.length).toBeGreaterThan(0); expect(output.metrics.tokensPerSecond).toBeGreaterThan(0); expect(output.digest.length).toBeGreaterThan(20); }
      console.log("REAL OLLAMA Compare", pair.outputs.map((o) => ({ model: o.model, text: o.text, metrics: o.metrics })));
      const stopped = await service.startRun({ mode: "compare", models: ["qwen3:0.6b", "gemma3:1b"], prompt: "写一篇很长的旅行日记", systemPrompt: "", parameters: { ...parameters, maxTokens: 2000 } });
      await vi.waitFor(() => expect(service.getRun(stopped.id).outputs[0].text.length).toBeGreaterThan(0), { timeout: 30000, interval: 100 }); service.stopRun();
      await waitForRun(service, stopped.id, "stopped", 30000); expect(service.getRun(stopped.id).outputs[1].text).toBe("");
      const retry = await service.startRun({ mode: "playground", models: ["gemma3:1b"], prompt: "只回答：测试完成", systemPrompt: "", parameters });
      await waitForRun(service, retry.id, "complete");
      await service.shutdown();
      const reopened = new LocalModelStore(root); await reopened.init(); expect(reopened.history()).toHaveLength(4); expect(reopened.getRun(comparison.id).outputs).toEqual(pair.outputs); await reopened.close();
      console.log("REAL OLLAMA stop/retry/restart persistence verified");
    } finally { await service.shutdown(); await rm(root, { recursive: true, force: true }); }
  }, 900000);
});
