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
function fixtureRun(model: string, id = model): LocalModelRun {
  return { id, mode: "playground", prompt: `${model} 的问题`, systemPrompt: `${model} 的角色`, parameters: preferences.parameters, createdAt: "2026-10-09T10:00:00Z", completedAt: "2026-10-09T10:00:01Z", status: "complete",
    outputs: [{ model, digest: "real-digest", parameterSize: "1B", quantization: "Q4", status: "complete", text: `${model} 的回答`, thinking: "", error: null,
      metrics: { firstOutputMs: 10, durationMs: 1234, loadMs: 10, inputTokens: 11, outputTokens: 12, tokensPerSecond: 12.34 } }] };
}
const lab: LabModule = { id: "local-model-lab", title: "LOCAL MODEL LAB", accent: "#c7d1de", symbol: "", purpose: "", views: [], Page: () => null };
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
describe("local model desktop presentation and state", () => {
  it("renders both approved layouts with explicit comparison targets, real models and no invented measurements", async () => {
    const store = await import("./local-model-store"); const { LocalModelPage } = await import("./Page"); store.acceptLocalModelEvent({ type: "state", state: fixture() });
    const playground = renderToStaticMarkup(createElement(LocalModelPage, { lab, viewId: "playground" }));
    expect(playground).toContain("RUN PROMPT"); expect(playground).toContain("qwen3:0.6b"); expect(playground).toContain("2 个已下载模型"); expect(playground).not.toContain("个已载入"); expect(playground).not.toContain("38 tok/s"); expect(playground).toContain("独立实验");
    expect(playground).toContain('class="lm-model is-selected"'); expect(playground).not.toContain('class="lm-model is-selected is-a"'); expect(playground).not.toContain('class="lm-model is-selected is-b"');
    const compare = renderToStaticMarkup(createElement(LocalModelPage, { lab, viewId: "compare" }));
    expect(compare).toContain("RUN COMPARISON"); expect(compare).toContain("选 A"); expect(compare).toContain("选 B"); expect(compare).toContain("先 A 后 B"); expect(compare).toContain("SHARED SETTINGS"); expect(compare).not.toContain("4.9 GB");
    expect(compare).toContain('class="lm-model is-selected is-a"'); expect(compare).toContain('class="lm-model is-selected is-b"');
  });
  it("keeps per-model memory information and unloading while removing the loaded-model counter", async () => {
    const store = await import("./local-model-store"); const { LocalModelPage } = await import("./Page"); const { ModelDetailsDialog } = await import("./Dialogs");
    const data = fixture(); data.models[0] = { ...data.models[0], loaded: true, memoryBytes: 875_000_000 };
    store.acceptLocalModelEvent({ type: "state", state: data });
    const page = renderToStaticMarkup(createElement(LocalModelPage, { lab }));
    expect(page).toContain("2 个已下载模型"); expect(page).not.toContain("个已载入"); expect(page).toContain("载入 875 MB");
    const details = renderToStaticMarkup(createElement(ModelDetailsDialog, { model: data.models[0], onClose: () => {} }));
    expect(details).toContain("已载入 · 875 MB"); expect(details).toContain("释放内存"); expect(details).not.toMatch(/disabled=""[^>]*>释放内存/u);
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
    expect(css.split(".lm-download progress {")[1]?.split("}")[0]).toContain("appearance: none");
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
    expect(markup).toContain("已下载，可直接运行"); expect(markup).not.toContain("未逐款"); expect(markup).not.toContain("目录核对"); expect(markup).not.toContain("qwen3:8b");
  });
  it("presents every installed source consistently instead of retaining the last completed transfer UI", async () => {
    const store = await import("./local-model-store"); const { PullModelDialog } = await import("./Dialogs");
    for (const model of ["qwen3:0.6b", "hf.co/LiquidAI/LFM2.5-350M-GGUF:Q4_0"]) {
      const data = fixture(); data.models.push({ ...data.models[0], name: model });
      const download: LocalModelDownload = { model, status: "complete", message: "模型已下载，可返回实验台使用", completed: 100, total: 100, error: null, bytesPerSecond: null, remainingSeconds: null, startedAt: "2026-10-09T10:00:00Z", updatedAt: "2026-10-09T10:01:00Z" };
      store.acceptLocalModelEvent({ type: "state", state: { ...data, download } });
      const render = () => renderToStaticMarkup(createElement(PullModelDialog, { onClose: () => {}, initialName: model }));
      expect(render()).toContain("检查模型更新"); expect(render()).toContain("已下载，可直接运行");
      expect(render()).not.toContain('aria-label="当前模型下载"'); expect(render()).not.toContain("模型下载进度");
      for (const status of ["downloading", "paused", "error"] as const) {
        store.acceptLocalModelEvent({ type: "download", download: { ...download, status } });
        expect(render()).toContain('aria-label="当前模型下载"');
      }
      store.acceptLocalModelEvent({ type: "download", download: { ...download, status: "cancelled" } });
      expect(render()).toContain("检查模型更新"); expect(render()).not.toContain("重新下载");
    }
  });
  it("uses the same download explanation for GGUF models without removing source badges", async () => {
    const store = await import("./local-model-store"); const { PullModelDialog } = await import("./Dialogs"); const { localModelCatalog } = await import("./model-catalog");
    store.acceptLocalModelEvent({ type: "state", state: fixture() });
    const models = localModelCatalog.flatMap((group) => group.models).filter((model) => model.availability === "huggingface");
    expect(models).toHaveLength(3);
    for (const name of [...models.map((model) => model.name), "hf.co/example/custom-model:Q4_K_M"]) {
      const markup = renderToStaticMarkup(createElement(PullModelDialog, { onClose: () => {}, initialName: name }));
      expect(markup).toContain("暂停或重试会复用已下载文件"); expect(markup).toContain("Hugging Face · GGUF");
      expect(markup).not.toContain("GGUF 的可运行性取决于模型架构和运行时支持");
    }
  });
  it("scopes drafts, answers and measurements to the model and ordered A/B pair", async () => {
    const store = await import("./local-model-store"); const { LocalModelPage } = await import("./Page");
    const data = fixture(); const qwen = fixtureRun("qwen3:0.6b"); const gemma = fixtureRun("gemma3:1b");
    store.acceptLocalModelEvent({ type: "state", state: { ...data, latestRun: qwen } });
    const render = (viewId = "playground") => renderToStaticMarkup(createElement(LocalModelPage, { lab, viewId }));
    expect(render()).toContain(qwen.prompt); expect(render()).toContain(qwen.outputs[0].text);
    store.acceptLocalModelEvent({ type: "state", state: { ...data, preferences: { ...data.preferences, selectedModel: "gemma3:1b" }, latestRun: qwen } });
    expect(render()).toContain("这个模型还没有实验记录"); expect(render()).not.toContain(qwen.prompt); expect(render()).not.toContain(qwen.outputs[0].text); expect(render()).not.toContain("12.3 tok/s");
    store.acceptLocalModelEvent({ type: "run", run: gemma });
    expect(render()).toContain(gemma.prompt); expect(render()).toContain(gemma.outputs[0].text); expect(render()).not.toContain(qwen.outputs[0].text);
    const gemmaKey = store.localModelExperimentKey("playground", ["gemma3:1b"]);
    store.setLocalModelDraft(gemmaKey, { prompt: "Gemma 未发送草稿", systemPrompt: "保留角色" });
    store.acceptLocalModelEvent({ type: "state", state: { ...data, latestRun: gemma } });
    expect(render()).toContain(qwen.prompt); expect(render()).toContain(qwen.outputs[0].text); expect(render()).not.toContain("Gemma 未发送草稿");
    const compare = { ...qwen, id: "comparison", mode: "compare" as const, prompt: "A/B 对照问题", outputs: [qwen.outputs[0], gemma.outputs[0]] };
    store.acceptLocalModelEvent({ type: "run", run: compare });
    expect(render("compare")).toContain(compare.prompt); expect(render("compare")).toContain(qwen.outputs[0].text);
    store.acceptLocalModelEvent({ type: "state", state: { ...data, latestRun: compare, preferences: { ...data.preferences, modelA: "gemma3:1b", modelB: "qwen3:0.6b" } } });
    expect(render("compare")).toContain("这组模型还没有对照记录"); expect(render("compare")).not.toContain(compare.prompt); expect(render("compare")).not.toContain(gemma.outputs[0].text);
    store.acceptLocalModelEvent({ type: "state", state: { ...data, preferences: { ...data.preferences, selectedModel: "gemma3:1b" }, latestRun: compare } });
    expect(render()).toContain("Gemma 未发送草稿"); expect(render()).toContain(gemma.outputs[0].text);
    expect(store.localModelExperimentKey("playground", ["example"])).toBe(store.localModelExperimentKey("playground", ["EXAMPLE:latest"]));
  });
  it("restores SQLite records on demand without delayed reads overwriting new input or streaming output", async () => {
    const store = await import("./local-model-store"); const data = fixture(); store.acceptLocalModelEvent({ type: "state", state: data });
    let finishRead!: (run: LocalModelRun | null) => void;
    const read = vi.fn(() => new Promise<LocalModelRun | null>((resolve) => { finishRead = resolve; }));
    vi.stubGlobal("window", { agentLab: { getLatestLocalModelRun: read } });
    const lookup = store.ensureLocalModelRun("playground", ["qwen3:0.6b"]);
    expect(store.ensureLocalModelRun("playground", ["QWEN3:0.6B"])).toBe(lookup); expect(read).toHaveBeenCalledTimes(1);
    const key = store.localModelExperimentKey("playground", ["qwen3:0.6b"]);
    store.setLocalModelDraft(key, { prompt: "新输入不能被旧记录覆盖", systemPrompt: "" });
    const live = { ...fixtureRun("qwen3:0.6b", "live"), status: "running" as const, outputs: [{ ...fixtureRun("qwen3:0.6b").outputs[0], status: "running" as const, text: "流式新输出，不能回退" }] };
    store.acceptLocalModelEvent({ type: "run", run: live });
    finishRead(fixtureRun("qwen3:0.6b", "old")); await lookup;
    expect(store.getLocalModelDraft(key).prompt).toBe("新输入不能被旧记录覆盖");
    const { LocalModelPage } = await import("./Page");
    const markup = renderToStaticMarkup(createElement(LocalModelPage, { lab }));
    expect(markup).toContain("STOP RUN"); expect(markup).toContain("流式新输出，不能回退"); expect(markup).not.toContain("qwen3:0.6b 的回答");
    read.mockImplementationOnce(async () => fixtureRun("gemma3:1b"));
    await store.ensureLocalModelRun("playground", ["gemma3:1b"]);
    expect(store.getLocalModelDraft(store.localModelExperimentKey("playground", ["gemma3:1b"])).prompt).toBe("gemma3:1b 的问题");
  });
  it("invalidates a deleted experiment without discarding another model or resurrecting a delayed record", async () => {
    const store = await import("./local-model-store"); const data = fixture();
    const gemma = fixtureRun("gemma3:1b"); store.acceptLocalModelEvent({ type: "state", state: { ...data, latestRun: gemma } });
    let finishRead!: (run: LocalModelRun | null) => void;
    const read = vi.fn(() => new Promise<LocalModelRun | null>((resolve) => { finishRead = resolve; }));
    const remove = vi.fn(async () => {});
    vi.stubGlobal("window", { agentLab: { getLatestLocalModelRun: read, deleteLocalModelRun: remove, getLocalModelState: async () => ({ ...data, latestRun: gemma }) } });
    const pending = store.ensureLocalModelRun("playground", ["qwen3:0.6b"]);
    await store.deleteLocalModelRun("qwen-deleted");
    finishRead(fixtureRun("qwen3:0.6b", "qwen-deleted")); await pending;
    expect(store.getLocalModelDraft(store.localModelExperimentKey("playground", ["qwen3:0.6b"])).prompt).toBe("");
    expect(store.getLocalModelDraft(store.localModelExperimentKey("playground", ["gemma3:1b"])).prompt).toBe(gemma.prompt);
    read.mockImplementationOnce(async () => fixtureRun("qwen3:0.6b", "older-surviving"));
    await store.ensureLocalModelRun("playground", ["qwen3:0.6b"]);
    expect(remove).toHaveBeenCalledWith("qwen-deleted"); expect(read).toHaveBeenCalledTimes(2);
    expect(store.getLocalModelDraft(store.localModelExperimentKey("playground", ["qwen3:0.6b"])).prompt).toBe("qwen3:0.6b 的问题");
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
    vi.stubGlobal("window", { agentLab: { saveLocalModelPreferences: async (p: LocalModelPreferences) => {
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
    const { downloadInProgress, downloadPercent, downloadStatusLabel, formatDownloadRate, formatDownloadRemaining } = await import("./download-presentation");
    expect(downloadInProgress(null)).toBe(false);
    const download = { status: "pausing", completed: 150, total: 100 } as LocalModelDownload;
    expect(downloadInProgress(download)).toBe(true); expect(downloadInProgress({ ...download, status: "paused" })).toBe(false);
    expect(downloadPercent(download)).toBe(100); expect(downloadPercent({ ...download, total: null })).toBeNull();
    expect(formatDownloadRate(null)).toBe("计算速度中…"); expect(formatDownloadRate(0)).toBe("等待下载数据…");
    expect(formatDownloadRate(0.5)).toBe("<1 B/s"); expect(formatDownloadRate(150)).toBe("150 B/s"); expect(formatDownloadRate(1500)).toBe("1.5 KB/s");
    expect(formatDownloadRemaining(null)).toBe(""); expect(formatDownloadRemaining(3)).toBe("约 3 秒"); expect(formatDownloadRemaining(7200)).toBe("约 2.0 小时");
    expect(downloadStatusLabel({ ...download, status: "downloading", message: "校验文件" })).toBe("校验中");
    expect(downloadStatusLabel({ ...download, status: "downloading", message: "安装模型" })).toBe("安装中");
    expect(downloadStatusLabel({ ...download, status: "complete", message: "安装模型" })).toBe("已下载");
  });
});
