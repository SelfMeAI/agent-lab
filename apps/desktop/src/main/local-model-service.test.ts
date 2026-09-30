import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalModelEvent, LocalModelRunRequest } from "../../../../packages/contracts/src/local-model";
import { OllamaClient } from "../../../../packages/runtime/src/ollama";
import { LocalModelService, ollamaMetrics } from "./local-model-service";
import { LocalModelStore, defaultLocalModelParameters } from "./local-model-store";
const roots: string[] = [], services: LocalModelService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.shutdown(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const models = ["a:latest", "b:latest"].map((name) => ({ name, digest: `digest-${name}`, size: 123, parameterSize: "1B", quantization: "Q4", loaded: false, memoryBytes: null }));
async function prepare(): Promise<{ service: LocalModelService; client: OllamaClient; events: LocalModelEvent[] }> {
  const parent = fileURLToPath(new URL("../../../../.work/local-model-tests", import.meta.url)); await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, "service-")); roots.push(root);
  const client = new OllamaClient("http://127.0.0.1:1"); vi.spyOn(client, "version").mockResolvedValue("test"); vi.spyOn(client, "models").mockResolvedValue(models); vi.spyOn(client, "unload").mockResolvedValue();
  const events: LocalModelEvent[] = [];
  const service = new LocalModelService(new LocalModelStore(root), "unused", (event) => events.push(structuredClone(event)), { start: async () => client, stop: async () => {} });
  services.push(service); await service.init(); return { service, client, events };
}
function request(mode: "playground" | "compare" = "compare"): LocalModelRunRequest { return { mode, models: mode === "compare" ? ["a:latest", "b:latest"] : ["a:latest"], prompt: "一个问题", systemPrompt: "", parameters: { ...defaultLocalModelParameters } }; }
describe("local model experiments", () => {
  it("executes comparison sequentially with identical inputs, preserves deltas, metrics and model versions", async () => {
    const { service, client, events } = await prepare(); const order: string[] = []; let concurrent = 0;
    const chat = vi.spyOn(client, "chat").mockImplementation(async (name, prompt, system, params, signal, receive, unload) => {
      expect(concurrent++).toBe(0); order.push(`start ${name}`); expect(prompt).toBe("一个问题"); expect(params).toEqual(defaultLocalModelParameters); expect(unload).toBe(true);
      receive({ message: { thinking: "分析", content: `${name} 回答` } }); await new Promise((resolve) => setTimeout(resolve, 5));
      receive({ done: true, prompt_eval_count: 10, eval_count: 20, eval_duration: 1e9, load_duration: 5e6 }); concurrent--; order.push(`end ${name}`);
    });
    const run = await service.startRun(request());
    await vi.waitFor(() => expect(service.store.getRun(run.id).status).toBe("complete"));
    expect(order).toEqual(["start a:latest", "end a:latest", "start b:latest", "end b:latest"]); expect(chat).toHaveBeenCalledTimes(2);
    const recorded = service.getRun(run.id); expect(recorded.outputs[1]).toMatchObject({ digest: "digest-b:latest", thinking: "分析", text: "b:latest 回答", metrics: { inputTokens: 10, outputTokens: 20, tokensPerSecond: 20, loadMs: 5 } });
    expect(events.some((e) => e.type === "run" && e.run.outputs[0].text && e.run.status === "running")).toBe(true);
  });
  it("stop preserves partial output and never starts the second model, retry is immediately possible", async () => {
    const { service, client } = await prepare();
    const chat = vi.spyOn(client, "chat").mockImplementationOnce(async (_name, _prompt, _sys, _p, signal, receive) => {
      receive({ message: { content: "部分内容" } });
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }).mockImplementation(async (_n, _q, _s, _p, _signal, receive) => { receive({ message: { content: "重试成功" }, done: true }); });
    const run = await service.startRun(request()); await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    service.stopRun(); await vi.waitFor(() => expect(service.getRun(run.id).status).toBe("stopped"));
    expect(service.getRun(run.id).outputs).toMatchObject([{ status: "stopped", text: "部分内容" }, { status: "stopped", text: "" }]);
    const retry = await service.startRun(request("playground")); await vi.waitFor(() => expect(service.getRun(retry.id).status).toBe("complete"));
  });
  it("failure is terminal, remains in history and does not disable future runs", async () => {
    const { service, client } = await prepare();
    vi.spyOn(client, "chat").mockRejectedValueOnce(new Error("requires more memory")).mockImplementation(async (_n, _q, _s, _p, _signal, receive) => { receive({ message: { content: "okay" }, done: true }); });
    const run = await service.startRun(request("playground")); await vi.waitFor(() => expect(service.getRun(run.id).status).toBe("error")); expect(service.getRun(run.id).outputs[0].error).toContain("内存");
    expect((await service.getState()).activeRun).toBeNull(); const retry = await service.startRun(request("playground")); await vi.waitFor(() => expect(service.getRun(retry.id).status).toBe("complete"));
    expect(service.store.history()).toHaveLength(2); service.deleteRun(run.id); expect(service.store.history()).toHaveLength(1);
  });
  it("guards unknown models, duplicate comparison models, invalid options and overlapping preparation", async () => {
    const { service, client } = await prepare();
    await expect(service.startRun({ ...request(), models: ["a:latest", "a:latest"] })).rejects.toThrow("不同");
    await expect(service.startRun({ ...request(), models: ["a:latest", "missing"] })).rejects.toThrow("下载");
    await expect(service.startRun({ ...request(), parameters: { ...defaultLocalModelParameters, maxTokens: -1 } })).rejects.toThrow();
    vi.spyOn(client, "chat").mockImplementation(async (_n, _q, _s, _p, _signal, receive) => { receive({ done: true }); });
    const first = service.startRun(request()); await expect(service.startRun(request())).rejects.toThrow("当前实验"); await first;
    await vi.waitFor(() => expect(service.store.latest()?.status).toBe("complete"));
  });
  it("downloads exact progress, refreshes installed models, allows resuming after cancellation", async () => {
    const { service, client } = await prepare();
    vi.spyOn(client, "pull").mockImplementationOnce(async (_n, _signal, receive) => { receive({ status: "pulling digest", digest: "one", total: 100, completed: 100 }); receive({ status: "success" }); })
      .mockImplementation(async (_n, signal) => { await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); });
    await service.pull("a:latest"); await vi.waitFor(async () => expect((await service.getState()).download?.status).toBe("complete"));
    expect((await service.getState()).download).toMatchObject({ completed: 100, total: 100 }); expect(service.store.preferences.selectedModel).toBe("a:latest");
    await service.pull("b:latest"); await vi.waitFor(() => expect(client.pull).toHaveBeenCalledTimes(2)); service.stopDownload();
    await vi.waitFor(async () => expect((await service.getState()).download?.status).toBe("stopped"));
  });
  it("never fabricates absent metrics or divides by zero", () => {
    expect(ollamaMetrics({}, null, 4)).toEqual({ firstOutputMs: null, durationMs: 4, loadMs: null, inputTokens: null, outputTokens: null, tokensPerSecond: null });
    expect(ollamaMetrics({ eval_count: 3, eval_duration: 0 }, 2, 4).tokensPerSecond).toBeNull();
  });
});
