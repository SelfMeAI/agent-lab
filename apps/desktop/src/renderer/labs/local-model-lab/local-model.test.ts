import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalModelDownload, LocalModelPreferences, LocalModelRun, LocalModelSnapshot } from "../../../../../../packages/contracts/src/local-model";
import type { LabModule } from "../types";

const preferences: LocalModelPreferences = { selectedModel: "qwen3:0.6b", modelA: "qwen3:0.6b", modelB: "gemma3:1b", parameters: { temperature: 0.7, contextLength: 4096, seed: null, maxTokens: 2048, thinking: "auto" } };
function fixture(): LocalModelSnapshot {
  return { runtime: { status: "ready", version: "0.35.0", endpoint: "http://127.0.0.1:1", error: null }, modelsDirectory: "/app-data/models", preferences: structuredClone(preferences), download: null, history: [], latestRun: null, activeRun: null,
    models: ["qwen3:0.6b", "gemma3:1b"].map((name) => ({ name, digest: "abcdef123456", size: 1000000000, parameterSize: "1B", quantization: "Q4", loaded: false, memoryBytes: null })) };
}
const lab: LabModule = { id: "local-model-lab", title: "LOCAL MODEL LAB", group: "runtimes", accent: "#c7d1de", symbol: "", purpose: "", views: [] };
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
describe("local model desktop presentation and state", () => {
  it("renders both approved layouts with explicit comparison targets, real models and no invented measurements", async () => {
    const store = await import("./local-model-store"); const { LocalModelPage } = await import("./Page"); store.acceptLocalModelEvent({ type: "state", state: fixture() });
    const playground = renderToStaticMarkup(createElement(LocalModelPage, { lab, viewId: "playground" }));
    expect(playground).toContain("RUN PROMPT"); expect(playground).toContain("qwen3:0.6b"); expect(playground).toContain("0 个已载入"); expect(playground).not.toContain("38 tok/s"); expect(playground).toContain("独立实验");
    expect(playground).toContain('class="lm-model is-selected"'); expect(playground).not.toContain('class="lm-model is-selected is-a"'); expect(playground).not.toContain('class="lm-model is-selected is-b"');
    const compare = renderToStaticMarkup(createElement(LocalModelPage, { lab, viewId: "compare" }));
    expect(compare).toContain("RUN COMPARISON"); expect(compare).toContain("选 A"); expect(compare).toContain("选 B"); expect(compare).toContain("先 A 后 B"); expect(compare).toContain("SHARED SETTINGS"); expect(compare).not.toContain("4.9 GB");
    expect(compare).toContain('class="lm-model is-selected is-a"'); expect(compare).toContain('class="lm-model is-selected is-b"');
  });
  it("shares the silver module accent with the workspace and keeps comparison identities separate", async () => {
    const { localModelLab } = await import("./index"); const { LabPage } = await import("../LabPage");
    expect(localModelLab.accent).toBe("#c7d1de");
    expect(renderToStaticMarkup(createElement(LabPage, { lab: localModelLab, viewId: "playground" }))).toContain(`style="--accent:${localModelLab.accent}"`);
    const css = readFileSync(new URL("./local-model.css", import.meta.url), "utf8");
    expect(css).toContain(`--lm-accent: var(--accent, ${localModelLab.accent})`);
    for (const selector of [".lm-heading > svg", ".lm-tabs > button.is-active", ".lm-run", '.lm-setting input[type="range"]', ".lm-download progress::-webkit-progress-value"]) {
      const declaration = css.split(`${selector} {`)[1]?.split("}")[0];
      expect(declaration, selector).toContain("var(--lm-accent)");
    }
    expect(css).toContain("--lm-model-a: #c5f454"); expect(css).toContain("--lm-model-b: #49d8e8");
  });
  it("does not conflate model runtime settings with a cloud provider", async () => {
    const store = await import("./local-model-store"); const { LocalModelSettings } = await import("./Dialogs"); store.acceptLocalModelEvent({ type: "state", state: fixture() });
    const markup = renderToStaticMarkup(createElement(LocalModelSettings, { onClose: () => {} }));
    expect(markup).toContain("MODELS DIRECTORY"); expect(markup).toContain("无需 API Key"); expect(markup).toContain("更换目录不会移动或删除原模型"); expect(markup).not.toContain("API BASE URL"); expect(markup).not.toContain("填写 API Key");
  });
  it("renders the grouped catalog with real installed badges, corrected sizes and selectable HF GGUF sources", async () => {
    const store = await import("./local-model-store"); const { PullModelDialog } = await import("./Dialogs"); store.acceptLocalModelEvent({ type: "state", state: fixture() });
    const markup = renderToStaticMarkup(createElement(PullModelDialog, { onClose: () => {} }));
    expect(markup).toContain("按模型系列筛选"); expect(markup).toContain("小模型下载列表");
    expect(markup).toContain("523 MB"); expect(markup).toContain("105 MB");
    expect(markup.match(/is-installed/g)).toHaveLength(2);
    expect(markup).not.toContain("is-unavailable");
    expect(markup).toContain("Hugging Face · GGUF"); expect(markup).toContain("hf.co/LiquidAI/"); expect(markup).toContain("检查模型更新"); expect(markup).toContain("1.3 GB");
    expect(markup).toContain("未逐款在本应用验收"); expect(markup).not.toContain("qwen3:8b");
  });
  it("keeps the expanded catalog scroll separate from the input, filters and download action", () => {
    const css = readFileSync(new URL("./local-model.css", import.meta.url), "utf8");
    expect(css.split(".lm-pull-dialog .settings-panel__body {")[1]?.split("}")[0]).toContain("overflow: hidden");
    expect(css.split(".lm-catalog-scroll {")[1]?.split("}")[0]).toContain("overflow-y: auto");
    for (const selector of [".lm-catalog-filters", ".lm-catalog-submit"]) expect(css.split(`${selector} {`)[1]?.split("}")[0]).toContain("flex: 0 0 auto");
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
  it("offers state-specific download controls without presenting a stopped task as still transferring", async () => {
    const store = await import("./local-model-store"); const { DownloadCard, LocalModelSettings } = await import("./Dialogs");
    const download: LocalModelDownload = { model: "qwen3:0.6b", status: "downloading", message: "下载模型文件", completed: 200000000, total: 522000000, bytesPerSecond: 4000000, remainingSeconds: 81, error: null, startedAt: "2026-10-08T10:00:00Z", updatedAt: "2026-10-08T10:01:00Z" };
    store.acceptLocalModelEvent({ type: "state", state: { ...fixture(), download } });
    const card = (status: LocalModelDownload["status"]): string => renderToStaticMarkup(createElement(DownloadCard, { download: { ...download, status }, onClose: () => {} }));
    expect(card("downloading")).toContain("暂停"); expect(card("downloading")).toContain("4.0 MB/s"); expect(card("downloading")).toContain("约 2 分钟");
    expect(card("pausing")).toContain("正在暂停…"); expect(card("pausing")).not.toContain("继续下载");
    expect(card("paused")).toContain("继续下载"); expect(card("paused")).not.toContain("MB/s"); expect(card("paused")).toContain("取消下载");
    expect(card("error")).toContain("重试下载"); expect(card("cancelled")).toContain("重新下载"); expect(card("complete")).toContain("返回实验");
    expect(renderToStaticMarkup(createElement(LocalModelSettings, { onClose: () => {} }))).toMatch(/disabled=""[^>]*>更换目录/u);
  });
  it("distinguishes an unavailable local runtime from an empty usable model library", async () => {
    const store = await import("./local-model-store"); const { LocalModelPage } = await import("./Page");
    store.acceptLocalModelEvent({ type: "state", state: { ...fixture(), models: [], runtime: { status: "error", version: null, endpoint: null, error: "内置运行时缺失" } } });
    const unavailable = renderToStaticMarkup(createElement(LocalModelPage, { lab }));
    expect(unavailable).toContain("本地模型服务尚未就绪"); expect(unavailable).not.toContain("还没有本地模型");
    store.acceptLocalModelEvent({ type: "state", state: { ...fixture(), models: [] } });
    const empty = renderToStaticMarkup(createElement(LocalModelPage, { lab })); expect(empty).toContain("还没有本地模型");
  });
  it("formats download estimates honestly and treats transitions as busy", async () => {
    const { downloadInProgress, downloadPercent, formatDownloadRate, formatDownloadRemaining } = await import("./download-presentation");
    expect(downloadInProgress(null)).toBe(false);
    const download = { status: "pausing", completed: 150, total: 100 } as LocalModelDownload;
    expect(downloadInProgress(download)).toBe(true); expect(downloadInProgress({ ...download, status: "paused" })).toBe(false);
    expect(downloadPercent(download)).toBe(100); expect(downloadPercent({ ...download, total: null })).toBeNull();
    expect(formatDownloadRate(null)).toBe("计算速度中…"); expect(formatDownloadRate(0)).toBe("等待下载数据…");
    expect(formatDownloadRate(0.5)).toBe("<1 B/s"); expect(formatDownloadRate(150)).toBe("150 B/s"); expect(formatDownloadRate(1500)).toBe("1.5 KB/s");
    expect(formatDownloadRemaining(null)).toBe(""); expect(formatDownloadRemaining(3)).toBe("约 3 秒"); expect(formatDownloadRemaining(7200)).toBe("约 2.0 小时");
  });
});
