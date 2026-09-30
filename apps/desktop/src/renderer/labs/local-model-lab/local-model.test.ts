import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalModelPreferences, LocalModelRun, LocalModelSnapshot } from "../../../../../../packages/contracts/src/local-model";
import type { LabModule } from "../types";

const preferences: LocalModelPreferences = { selectedModel: "qwen3:0.6b", modelA: "qwen3:0.6b", modelB: "gemma3:1b", parameters: { temperature: 0.7, contextLength: 4096, seed: null, maxTokens: 2048, thinking: "auto" } };
function fixture(): LocalModelSnapshot {
  return { runtime: { status: "ready", version: "0.35.0", endpoint: "http://127.0.0.1:1", error: null }, modelsDirectory: "/app-data/models", preferences: structuredClone(preferences), download: null, history: [], latestRun: null, activeRun: null,
    models: ["qwen3:0.6b", "gemma3:1b"].map((name) => ({ name, digest: "abcdef123456", size: 1000000000, parameterSize: "1B", quantization: "Q4", loaded: false, memoryBytes: null })) };
}
const lab: LabModule = { id: "local-model-lab", title: "LOCAL MODEL LAB", group: "runtimes", accent: "#cfed72", symbol: "", purpose: "", views: [] };
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
describe("local model desktop presentation and state", () => {
  it("renders both approved layouts with explicit comparison targets, real models and no invented measurements", async () => {
    const store = await import("./local-model-store"); const { LocalModelPage } = await import("./Page"); store.acceptLocalModelEvent({ type: "state", state: fixture() });
    const playground = renderToStaticMarkup(createElement(LocalModelPage, { lab, viewId: "playground" }));
    expect(playground).toContain("RUN PROMPT"); expect(playground).toContain("qwen3:0.6b"); expect(playground).toContain("0 个已载入"); expect(playground).not.toContain("38 tok/s"); expect(playground).toContain("独立实验");
    const compare = renderToStaticMarkup(createElement(LocalModelPage, { lab, viewId: "compare" }));
    expect(compare).toContain("RUN COMPARISON"); expect(compare).toContain("选 A"); expect(compare).toContain("选 B"); expect(compare).toContain("先 A 后 B"); expect(compare).toContain("SHARED SETTINGS"); expect(compare).not.toContain("4.9 GB");
  });
  it("does not conflate model runtime settings with a cloud provider", async () => {
    const store = await import("./local-model-store"); const { LocalModelSettings } = await import("./Dialogs"); store.acceptLocalModelEvent({ type: "state", state: fixture() });
    const markup = renderToStaticMarkup(createElement(LocalModelSettings, { onClose: () => {} }));
    expect(markup).toContain("MODELS DIRECTORY"); expect(markup).toContain("无需 API Key"); expect(markup).toContain("更换目录不会移动或删除原模型"); expect(markup).not.toContain("API BASE URL"); expect(markup).not.toContain("填写 API Key");
  });
  it("keeps streaming output during page navigation and makes terminal errors runnable", async () => {
    const store = await import("./local-model-store"); store.acceptLocalModelEvent({ type: "state", state: fixture() });
    const run: LocalModelRun = { id: "run", mode: "playground", prompt: "p", systemPrompt: "", parameters: preferences.parameters, createdAt: new Date().toISOString(), completedAt: null, status: "running", outputs: [] };
    store.acceptLocalModelEvent({ type: "run", run });
    const { LocalModelPage } = await import("./Page");
    expect(renderToStaticMarkup(createElement(LocalModelPage, { lab, viewId: "playground" }))).toContain("STOP RUN");
    expect(renderToStaticMarkup(createElement(LocalModelPage, { lab, viewId: "compare" }))).toContain("Playground 正在运行");
    store.acceptLocalModelEvent({ type: "run", run: { ...run, status: "error" } });
    expect(renderToStaticMarkup(createElement(LocalModelPage, { lab, viewId: "playground" }))).toContain("RUN PROMPT");
  });
  it("serializes preferences and ignores stale preference events while saving newer input", async () => {
    const store = await import("./local-model-store"); store.acceptLocalModelEvent({ type: "state", state: fixture() });
    const writes: LocalModelPreferences[] = [];
    vi.stubGlobal("window", { selfmeLab: { saveLocalModelPreferences: async (p: LocalModelPreferences) => {
      writes.push(p); store.acceptLocalModelEvent({ type: "state", state: { ...fixture(), preferences: p } }); return p;
    } } });
    await Promise.all([0.8, 0.9, 1.0].map((temperature) => store.saveLocalModelPreferences({ ...preferences, parameters: { ...preferences.parameters, temperature } })));
    expect(writes.map((p) => p.parameters.temperature)).toEqual([0.8, 0.9, 1]);
    const { LocalModelPage } = await import("./Page"); expect(renderToStaticMarkup(createElement(LocalModelPage, { lab }))).toContain("1.0");
  });
  it("formats real duration and size without inaccurate zeroes", async () => {
    const { formatModelDuration, formatBytes } = await import("./local-model-store");
    expect(formatModelDuration(null)).toBe("—"); expect(formatModelDuration(2)).toBe("<0.1 s"); expect(formatModelDuration(1500)).toBe("1.5 s"); expect(formatBytes(522000000)).toBe("522 MB");
  });
});
