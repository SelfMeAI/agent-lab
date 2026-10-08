import { randomUUID } from "node:crypto";
import type { LocalModelDownload, LocalModelEvent, LocalModelInfo, LocalModelMetrics, LocalModelPreferences, LocalModelRun, LocalModelRunRequest, LocalModelSnapshot } from "../../../../packages/contracts/src/local-model";
import { OllamaClient, ollamaError, sameLocalModel, validLocalModelName, type OllamaChunk } from "../../../../packages/runtime/src/ollama";
import { LocalModelStore, validateLocalModelParameters } from "./local-model-store";
import { OllamaProcess } from "./ollama-process";
import { DownloadProgress } from "./local-model-download";
import { prepareHuggingFaceMetadata, type ModelMetadataFetch } from "./hf-model-metadata";

type ManagedOllama = { start(directory: string): Promise<OllamaClient>; stop(): Promise<void> };
const emptyMetrics = (): LocalModelMetrics => ({ firstOutputMs: null, durationMs: null, loadMs: null, inputTokens: null, outputTokens: null, tokensPerSecond: null });
const metric = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;

export function ollamaMetrics(chunk: OllamaChunk, firstOutputMs: number | null, wallMs: number): LocalModelMetrics {
  const output = metric(chunk.eval_count), duration = metric(chunk.eval_duration), load = metric(chunk.load_duration);
  return { firstOutputMs, durationMs: wallMs, loadMs: load === null ? null : load / 1e6, inputTokens: metric(chunk.prompt_eval_count), outputTokens: output,
    tokensPerSecond: output !== null && duration !== null && duration > 0 ? output * 1e9 / duration : null };
}

export class LocalModelService {
  private readonly process: ManagedOllama;
  private runtime: LocalModelSnapshot["runtime"] = { status: "starting", version: null, endpoint: null, error: null };
  private models: LocalModelInfo[] = [];
  private active: LocalModelRun | null = null;
  private download: LocalModelDownload | null = null;
  private runAbort: AbortController | null = null;
  private pullAbort: AbortController | null = null;
  private runJob: Promise<void> | null = null;
  private pullJob: Promise<void> | null = null;
  private pullStopReason: "paused" | "cancelled" | null = null;
  private preparing = false;
  private changingDirectory = false;
  private modifyingModels = false;
  private closing = false;

  constructor(readonly store: LocalModelStore, executable: string, private readonly emit: (event: LocalModelEvent) => void, managed?: ManagedOllama, resolveProxy?: () => Promise<string>, private readonly fetchDownloadMetadata: ModelMetadataFetch = fetch) {
    this.process = managed ?? new OllamaProcess(executable, (message) => {
      this.runtime = { ...this.runtime, status: "error", error: message, endpoint: null };
      if (!this.closing) this.emitState();
    }, resolveProxy);
  }

  async init(): Promise<void> { await this.store.init(); this.download = this.store.getDownload(); }
  private snapshot(): LocalModelSnapshot {
    return structuredClone({ runtime: this.runtime, modelsDirectory: this.store.modelsDirectory, models: this.models, preferences: this.store.preferences,
      activeRun: this.active, latestRun: this.store.latest(), history: this.store.history(), download: this.download });
  }
  private emitState(): void { if (!this.closing) this.emit({ type: "state", state: this.snapshot() }); }
  private async client(): Promise<OllamaClient> {
    if (this.closing) throw new Error("应用正在退出");
    try {
      const client = await this.process.start(this.store.modelsDirectory);
      const version = await client.version();
      this.runtime = { status: "ready", version, endpoint: client.endpoint, error: null };
      return client;
    } catch (error) {
      this.runtime = { status: "error", version: null, endpoint: null, error: ollamaError(error) };
      this.emitState();
      throw error;
    }
  }

  async getState(): Promise<LocalModelSnapshot> {
    try { this.models = await (await this.client()).models(); } catch { /* return visible startup error, not a broken page */ }
    return this.snapshot();
  }
  async details(model: string): Promise<Awaited<ReturnType<OllamaClient["details"]>>> {
    this.checkModel(model); return (await this.client()).details(model);
  }
  async savePreferences(value: LocalModelPreferences): Promise<LocalModelPreferences> {
    const saved = await this.store.savePreferences(value); this.emitState(); return saved;
  }
  getRun(id: string): LocalModelRun { return this.store.getRun(id); }
  deleteRun(id: string): void {
    if (this.active?.id === id) throw new Error("运行中的实验不能删除");
    this.store.deleteRun(id); this.emitState();
  }
  private checkModel(name: string): void { if (!validLocalModelName(name)) throw new Error("请输入有效的本地模型名称，例如 qwen3:0.6b"); }
  private assertIdle(): void {
    if (this.closing || this.active || this.preparing || this.changingDirectory || this.modifyingModels) throw new Error("请先完成当前实验或模型操作，再进行此操作");
  }

  async startRun(value: LocalModelRunRequest): Promise<LocalModelRun> {
    this.assertIdle(); this.preparing = true;
    try {
      if (!value || (value.mode !== "playground" && value.mode !== "compare") || !Array.isArray(value.models)) throw new Error("实验请求格式无效");
      if (value.models.length !== (value.mode === "compare" ? 2 : 1) || new Set(value.models).size !== value.models.length) throw new Error("请选择不同的本地模型");
      value.models.forEach((name) => this.checkModel(name));
      if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 32000) throw new Error("请输入实验提示词，最多 32000 个字符");
      if (typeof value.systemPrompt !== "string" || value.systemPrompt.length > 8192) throw new Error("System prompt 最多 8192 个字符");
      const parameters = validateLocalModelParameters(value.parameters);
      if (this.pullAbort && value.models.some((name) => sameLocalModel(name, this.download!.model))) throw new Error("该模型正在下载，请等待下载完成");
      const client = await this.client(); this.models = await client.models();
      if (this.closing) throw new Error("应用正在退出");
      const selected = value.models.map((name) => this.models.find((m) => m.name === name));
      if (selected.some((m) => !m)) throw new Error("所选模型尚未下载，请先下载模型");
      const run: LocalModelRun = { id: randomUUID(), mode: value.mode, prompt: value.prompt.trim(), systemPrompt: value.systemPrompt.trim(), parameters,
        createdAt: new Date().toISOString(), completedAt: null, status: "running", outputs: selected.map((m) => ({ model: m!.name, digest: m!.digest, parameterSize: m!.parameterSize,
          quantization: m!.quantization, status: "pending", text: "", thinking: "", error: null, metrics: emptyMetrics() })) };
      this.store.saveRun(run); this.active = run;
      const controller = new AbortController(); this.runAbort = controller;
      this.emit({ type: "run", run: structuredClone(run) });
      // An experiment is deliberately independent: no hidden prior conversation is sent.
      const job = this.execute(client, run, controller);
      this.runJob = job;
      void job.finally(() => { if (this.runJob === job) this.runJob = null; }).catch((error) => console.error("保存本地实验失败：", error));
      return structuredClone(run);
    } finally { this.preparing = false; }
  }

  private async execute(client: OllamaClient, run: LocalModelRun, abort: AbortController): Promise<void> {
    let lastPublished = 0;
    const publish = (force = false): void => {
      if (!force && Date.now() - lastPublished < 100) return;
      lastPublished = Date.now(); this.store.saveRun(run);
      if (!this.closing) this.emit({ type: "run", run: structuredClone(run) });
    };
    try {
      if (run.mode === "compare") {
        // Cold, sequential runs. The same options do not make different models deterministic.
        for (const loaded of this.models.filter((m) => m.loaded)) { abort.signal.throwIfAborted(); await client.unload(loaded.name); }
      }
      for (const output of run.outputs) {
        abort.signal.throwIfAborted();
        output.status = "running"; publish(true);
        const started = performance.now(); let firstOutput: number | null = null;
        try {
          await client.chat(output.model, run.prompt, run.systemPrompt, run.parameters, abort.signal, (chunk) => {
            if ((chunk.message?.content || chunk.message?.thinking) && firstOutput === null) firstOutput = performance.now() - started;
            output.text += chunk.message?.content ?? ""; output.thinking += chunk.message?.thinking ?? "";
            if (chunk.done) { output.metrics = ollamaMetrics(chunk, firstOutput, performance.now() - started); output.finishReason = chunk.done_reason?.slice(0, 40) ?? null; }
            publish(chunk.done);
          }, run.mode === "compare");
          output.status = "complete";
        } catch (error) {
          output.status = abort.signal.aborted ? "stopped" : "error";
          output.error = abort.signal.aborted ? null : ollamaError(error);
          output.metrics.firstOutputMs = firstOutput; output.metrics.durationMs = performance.now() - started;
        }
        publish(true);
        if (abort.signal.aborted) break;
      }
      run.status = abort.signal.aborted ? "stopped" : run.outputs.some((o) => o.status === "error") ? "error" : "complete";
    } catch (error) {
      run.status = abort.signal.aborted ? "stopped" : "error";
      for (const output of run.outputs) if (output.status === "pending" || output.status === "running") {
        output.status = run.status; output.error = run.status === "error" ? ollamaError(error) : null;
      }
    } finally {
      for (const output of run.outputs) if (output.status === "pending") output.status = "stopped";
      run.completedAt = new Date().toISOString();
      this.active = null; this.runAbort = null; publish(true);
      if (!this.closing) {
        try { this.models = await client.models(); } catch { /* runtime error is shown on refresh/retry */ }
      }
      this.emitState();
    }
  }

  stopRun(): void { this.runAbort?.abort(); }

  async pull(model: string): Promise<void> {
    this.checkModel(model);
    if (this.pullAbort || this.preparing || this.changingDirectory || this.modifyingModels || this.closing) throw new Error("已有模型操作进行中，请先停止或等待完成");
    if (this.download?.status === "paused" && !sameLocalModel(this.download.model, model)) throw new Error("请先继续或取消已暂停的下载，再下载其他模型");
    if (this.active?.outputs.some((o) => sameLocalModel(o.model, model))) throw new Error("该模型正在实验中，请先停止实验");
    const previous = this.download && sameLocalModel(this.download.model, model) && ["paused", "error"].includes(this.download.status) ? this.download : null;
    const abort = new AbortController(); this.pullAbort = abort;
    this.pullStopReason = null;
    this.download = { model, status: "downloading", message: previous ? "确认缓存并继续下载" : "获取模型清单", completed: previous?.completed ?? null, total: previous?.total ?? null, error: null,
      startedAt: previous?.startedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), bytesPerSecond: null, remainingSeconds: null };
    try { this.publishDownload(); }
    catch (error) { this.pullAbort = null; this.download = previous; throw error; }
    const job = this.downloadModel(model, abort); this.pullJob = job;
    void job.finally(() => { if (this.pullJob === job) this.pullJob = null; }).catch((error) => console.error("保存模型下载结果失败：", error));
  }

  private publishDownload(persist = true): void {
    if (!this.download) return;
    this.download.updatedAt = new Date().toISOString();
    if (persist) this.store.saveDownload(this.download);
    if (!this.closing) this.emit({ type: "download", download: { ...this.download } });
  }

  private async downloadModel(model: string, abort: AbortController): Promise<void> {
    const progress = new DownloadProgress();
    let lastPublished = 0, lastPersisted = 0;
    let lastProgressAt = Date.now(), lastStatus = "", lastCompleted = 0, verifying = false, stalled = false;
    const watchdog = setInterval(() => {
      if (!abort.signal.aborted && Date.now() - lastProgressAt > (verifying ? 300000 : 120000)) { stalled = true; abort.abort(); }
    }, 1000);
    try {
      const client = await this.client(); abort.signal.throwIfAborted();
      const receive = (chunk: OllamaChunk): void => {
        if (abort.signal.aborted) return;
        const received = progress.receive(chunk);
        const changed = chunk.status !== lastStatus;
        if (changed || (received.completed ?? 0) > lastCompleted) lastProgressAt = Date.now();
        lastStatus = chunk.status ?? ""; lastCompleted = received.completed ?? 0;
        verifying = Boolean(chunk.status?.startsWith("verifying") || chunk.status === "writing manifest" || chunk.status === "success");
        this.download = { ...this.download!, ...received, status: "downloading", message: chunk.status === "success" ? "模型验证完成" : chunk.status === "pulling manifest" ? "获取模型清单" : chunk.status === "pulling metadata license" ? "下载许可证文件" : chunk.status === "pulling metadata template" ? "下载对话模板" : chunk.status === "pulling metadata config" ? "下载模型配置" : chunk.status?.startsWith("pulling ") ? "下载模型文件" : chunk.status?.startsWith("verifying") ? "校验文件" : chunk.status === "writing manifest" ? "安装模型" : "准备模型" };
        if (changed || Date.now() - lastPublished > 150 || chunk.status === "success") {
          lastPublished = Date.now();
          const persist = changed || Date.now() - lastPersisted > 1000;
          if (persist) lastPersisted = Date.now();
          this.publishDownload(persist);
        }
      };
      await prepareHuggingFaceMetadata(model, client, { signal: abort.signal, request: this.fetchDownloadMetadata, receive, plan: (layers) => progress.plan(layers) });
      abort.signal.throwIfAborted();
      await client.pull(model, abort.signal, receive);
      abort.signal.throwIfAborted();
      this.models = await client.models();
      const actual = this.models.find((m) => sameLocalModel(m.name, model));
      if (!actual) throw new Error("下载已返回成功，但本机尚未找到该模型，请重试以检查模型文件");
      const prefs = this.store.preferences;
      if (actual && !prefs.selectedModel) await this.store.savePreferences({ ...prefs, selectedModel: actual.name, modelA: prefs.modelA ?? actual.name });
      this.download = { ...this.download!, status: "complete", message: "模型已下载，可返回实验台使用", completed: this.download!.total, bytesPerSecond: null, remainingSeconds: null };
    } catch (error) {
      const status = stalled ? "error" : abort.signal.aborted ? this.pullStopReason ?? "paused" : "error";
      this.download = { ...this.download!, status, message: status === "paused" ? "下载已暂停，可继续下载" : status === "cancelled" ? "下载已取消" : "下载失败，可重试",
        error: stalled ? verifying ? "模型校验或安装超过五分钟没有新进展，请重试。已下载的文件会保留。" : "下载连续两分钟没有新进展，请检查网络后重试。已保存的分片可继续使用。" : abort.signal.aborted ? null : ollamaError(error), bytesPerSecond: null, remainingSeconds: null };
    } finally {
      clearInterval(watchdog);
      this.pullAbort = null;
      this.pullStopReason = null;
      this.publishDownload(); this.emitState();
    }
  }
  async pauseDownload(): Promise<void> {
    if (!this.pullAbort || this.download?.status !== "downloading") return;
    this.pullStopReason = "paused";
    this.download = { ...this.download, status: "pausing", message: "正在暂停下载…", bytesPerSecond: null, remainingSeconds: null };
    this.publishDownload(); this.pullAbort.abort();
    await this.pullJob;
  }
  async resumeDownload(): Promise<void> {
    if (!this.download || !["paused", "error"].includes(this.download.status)) throw new Error("没有可继续的下载");
    await this.pull(this.download.model);
  }
  async stopDownload(): Promise<void> {
    if (!this.download || ["complete", "cancelled"].includes(this.download.status)) return;
    if (this.pullAbort) {
      this.pullStopReason = "cancelled";
      this.download = { ...this.download, status: "cancelling", message: "正在取消下载…", bytesPerSecond: null, remainingSeconds: null };
      this.publishDownload(); this.pullAbort.abort();
      await this.pullJob;
    } else {
      this.download = { ...this.download, status: "cancelled", message: "下载已取消", error: null, bytesPerSecond: null, remainingSeconds: null };
      this.publishDownload(); this.emitState();
    }
  }
  async unload(model: string): Promise<void> {
    this.assertIdle(); this.checkModel(model);
    if (this.pullAbort && this.download && sameLocalModel(this.download.model, model)) throw new Error("该模型正在下载，请先暂停或完成下载");
    this.modifyingModels = true;
    try { const client = await this.client(); await client.unload(model); this.models = await client.models(); this.emitState(); }
    finally { this.modifyingModels = false; }
  }
  async deleteModel(model: string): Promise<void> {
    this.assertIdle(); this.checkModel(model);
    if (this.pullAbort) throw new Error("请先停止模型下载");
    this.modifyingModels = true;
    try {
      const client = await this.client(); await client.unload(model); await client.remove(model); this.models = await client.models();
      const prefs = this.store.preferences;
      await this.store.savePreferences({ ...prefs, selectedModel: prefs.selectedModel === model ? null : prefs.selectedModel,
        modelA: prefs.modelA === model ? null : prefs.modelA, modelB: prefs.modelB === model ? null : prefs.modelB });
      if (this.download && sameLocalModel(this.download.model, model)) { this.download = null; this.store.saveDownload(null); }
      this.emitState();
    } finally { this.modifyingModels = false; }
  }
  async changeDirectory(path: string): Promise<void> {
    this.assertIdle(); if (this.pullAbort) throw new Error("请先停止模型下载");
    this.changingDirectory = true;
    try {
      await this.process.stop(); await this.store.setModelsDirectory(path); this.models = []; this.download = this.store.getDownload();
      this.runtime = { status: "starting", version: null, endpoint: null, error: null }; this.emitState();
      await this.getState(); this.emitState();
    } finally { this.changingDirectory = false; }
  }
  async shutdown(): Promise<void> {
    this.closing = true; this.runAbort?.abort();
    if (this.pullAbort) { this.pullStopReason ??= "paused"; this.pullAbort.abort(); }
    await this.process.stop();
    await Promise.allSettled([this.runJob, this.pullJob]);
    await this.store.close();
  }
}
