import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LocalModelStore, defaultLocalModelParameters } from "./local-model-store";
import { LocalModelService } from "./local-model-service";
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
    if (state.download?.status === "error" || state.download?.status === "stopped") throw new Error(state.download.error ?? state.download.message);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("真实模型下载超时");
}

// Opt-in: real official runtime, real model downloads. Weights remain in the app's persistent directory.
describe.skipIf(process.env.RUN_OLLAMA_INTEGRATION !== "1")("packaged Ollama real-model path", () => {
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
