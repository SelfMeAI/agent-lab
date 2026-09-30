import { useEffect, useRef, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LocalModelInfo, LocalModelMetrics, LocalModelOutput, LocalModelParameters, LocalModelRun } from "../../../../../../packages/contracts/src/local-model";
import { goToLab } from "../../app/navigation";
import { LabIcon } from "../../shell/LabIcon";
import type { LabPageProps } from "../types";
import { ModelDetailsDialog, ModelHistoryDialog, PullModelDialog } from "./Dialogs";
import { localModelBridge, formatBytes, formatModelDuration, localModelDrafts, localModelError, localModelStatus, refreshLocalModels, saveLocalModelPreferences, useLocalModels } from "./local-model-store";
import "./local-model.css";

function CopyIcon(): JSX.Element { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="8" y="7" width="11" height="14" rx="2" /><path d="M15 7V3H4v14h4" /></svg>; }
function NumericInput({ id, value, min, max, nullable = false, className = "lm-input", onCommit }: { id: string; value: number | null; min: number; max: number; nullable?: boolean; className?: string; onCommit(value: number | null): void }): JSX.Element {
  const [draft, setDraft] = useState(value === null ? "" : String(value)); const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value === null ? "" : String(value)); }, [value]);
  const n = draft === "" ? null : Number(draft); const valid = n === null ? nullable : Number.isInteger(n) && n >= min && n <= max;
  return <input id={id} type="number" className={className} min={min} max={max} placeholder={nullable ? "Auto" : undefined} value={draft} aria-invalid={!valid} title={nullable ? `留空为 Auto，或输入 ${min}–${max}` : `${min}–${max}`} onFocus={() => { focused.current = true; }} onChange={(e) => setDraft(e.target.value)} onBlur={() => { focused.current = false; if (valid) onCommit(n); else setDraft(value === null ? "" : String(value)); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />;
}
function ResponsePanel({ output, index, compare }: { output?: LocalModelOutput; index: number; compare: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null); const following = useRef(true); const [copied, setCopied] = useState(false); const [copyError, setCopyError] = useState("");
  useEffect(() => { if (following.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [output?.text, output?.thinking]);
  useEffect(() => { following.current = true; if (ref.current) ref.current.scrollTop = 0; }, [output?.model]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); }, [copied]);
  async function copy(): Promise<void> { try { await navigator.clipboard.writeText(output?.text ?? ""); setCopied(true); setCopyError(""); } catch { setCopyError("复制失败，请选择文本复制"); } }
  const waiting = output?.status === "running" || output?.status === "pending";
  return <article className={`lm-response${compare && index === 1 ? " lm-response--b" : ""}`}>
    <header>{compare ? <b className={`lm-slot${index === 1 ? " lm-slot--b" : ""}`}>{index === 0 ? "A" : "B"}</b> : <strong>RESPONSE</strong>}<span className="lm-response__model" title={output?.model}>{output?.model ?? "尚未运行"}</span>
      {output && <small className={`lm-status lm-status--${output.status}`}>{waiting && <i className="lm-spinner" />}{localModelStatus[output.status]}</small>}
      <button type="button" className="lm-small-icon" aria-label={copied ? "已复制输出" : `复制${compare ? index === 0 ? " A" : " B" : ""}输出`} title="复制输出" disabled={!output?.text} onClick={() => void copy()}>{copied ? "✓" : <CopyIcon />}</button>
    </header>
    <div ref={ref} className="lm-response__body" onScroll={() => { if (ref.current) following.current = ref.current.scrollHeight - ref.current.scrollTop - ref.current.clientHeight < 48; }}>
      {!output && <div className="lm-output-empty"><LabIcon labId="local-model-lab" /><strong>{compare ? "同一输入，观察不同模型" : "给本地模型一个问题"}</strong><span>{compare ? "分别保留 A / B 的回答与真实指标" : "流式输出会显示在这里"}</span></div>}
      {output?.thinking && <details className="lm-thinking"><summary>思考过程{output.status === "running" && !output.text ? " · 输出中" : ""}</summary><div><ReactMarkdown remarkPlugins={[remarkGfm]}>{output.thinking}</ReactMarkdown></div></details>}
      {output?.text && <div className="lm-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{output.text}</ReactMarkdown></div>}
      {output && !output.text && !output.thinking && waiting && <div className="lm-awaiting"><span className="lm-spinner" />{output.status === "pending" ? compare && index === 1 ? "等待 A 完成后开始" : "准备运行…" : "正在加载模型并处理输入…"}</div>}
      {output?.error && <div className="lm-output-error" role="alert">{output.error}<span>调整后可重新运行，不需要切换页面。</span></div>}
      {output?.finishReason === "length" && <p className="lm-hint">已达到本次输出上限，回答可能未完整结束。可提高 Max output 后重新运行。</p>}
      {output && !output.text && !output.thinking && output.status === "stopped" && <p className="lm-hint">已停止，尚未生成内容。</p>}
      {output && output.status === "complete" && !output.text && <p className="lm-hint">未返回回答内容。可提高输出上限，或关闭模型思考后重试。</p>}
      {copyError && <p className="lm-hint" role="alert">{copyError}</p>}
    </div>
    {output && <footer title={`模型 digest：${output.digest}`}>{output.parameterSize} · {output.quantization}<code>{output.digest.slice(0, 12)}</code></footer>}
  </article>;
}

const measurementRows: Array<{ title: string; tooltip: string; display(m?: LocalModelMetrics): string }> = [
  { title: "Prompt tokens", tooltip: "运行时报告的输入 Token 数，不同模型的分词方式可能不同", display: (m) => m?.inputTokens?.toLocaleString() ?? "—" },
  { title: "Output tokens", tooltip: "运行时报告的生成 Token 数，可能包括思考 Token", display: (m) => m?.outputTokens?.toLocaleString() ?? "—" },
  { title: "Decode", tooltip: "生成 Token 数 ÷ 生成耗时，不含模型加载；速度不代表质量", display: (m) => m?.tokensPerSecond === null || m?.tokensPerSecond === undefined ? "—" : `${m.tokensPerSecond.toFixed(1)} tok/s` },
  { title: "First output", tooltip: "从发起该模型请求到首段内容或思考输出的实测时间", display: (m) => formatModelDuration(m?.firstOutputMs ?? null) },
  { title: "Load", tooltip: "Ollama 报告的模型加载耗时", display: (m) => formatModelDuration(m?.loadMs ?? null) },
  { title: "Total", tooltip: "该模型单次请求的完整实测耗时，包含准备与加载", display: (m) => formatModelDuration(m?.durationMs ?? null) },
];

export function LocalModelPage({ viewId }: LabPageProps): JSX.Element {
  const mode = viewId === "compare" ? "compare" : "playground"; const compare = mode === "compare";
  const { data, loading, error: storeError, runs } = useLocalModels();
  const [prompt, setPrompt] = useState(localModelDrafts[mode].prompt); const [system, setSystem] = useState(localModelDrafts[mode].systemPrompt);
  const [showSystem, setShowSystem] = useState(Boolean(system)); const [target, setTarget] = useState<"A" | "B">("A");
  const [dialog, setDialog] = useState<"pull" | "history" | null>(null); const [details, setDetails] = useState<LocalModelInfo | null>(null);
  const [error, setError] = useState(""); const [submitting, setSubmitting] = useState(false); const [stopping, setStopping] = useState(false);
  const [historyRun, setHistoryRun] = useState<LocalModelRun | null>(null);
  useEffect(() => { void refreshLocalModels(); }, []);
  useEffect(() => { localModelDrafts[mode] = { prompt, systemPrompt: system }; }, [mode, prompt, system]);
  useEffect(() => { if (!data?.activeRun) setStopping(false); }, [data?.activeRun]);
  const models = data?.models ?? [];
  const installed = (name?: string | null): string | null => name && models.some((m) => m.name === name) ? name : null;
  const selected = installed(data?.preferences.selectedModel) ?? models[0]?.name ?? null;
  const modelA = installed(data?.preferences.modelA) ?? selected;
  const modelB = installed(data?.preferences.modelB) !== modelA ? installed(data?.preferences.modelB) ?? models.find((m) => m.name !== modelA)?.name ?? null : models.find((m) => m.name !== modelA)?.name ?? null;
  const run = historyRun ?? runs[mode];
  const active = data?.activeRun; const busy = Boolean(active) || submitting; const inThisMode = active?.mode === mode;
  const parameters = data?.preferences.parameters ?? { temperature: 0.7, contextLength: 4096, seed: null, maxTokens: 2048, thinking: "auto" as const };
  async function chooseModel(model: string): Promise<void> {
    if (!data || busy) return;
    const next = { ...data.preferences };
    if (!compare) next.selectedModel = model;
    else if (target === "A") { next.modelA = model; next.modelB = modelB === model ? models.find((m) => m.name !== model)?.name ?? null : modelB; }
    else { next.modelB = model; next.modelA = modelA === model ? models.find((m) => m.name !== model)?.name ?? null : modelA; }
    setHistoryRun(null); await saveLocalModelPreferences(next).catch((cause) => setError(localModelError(cause)));
  }
  function parameter<K extends keyof LocalModelParameters>(key: K, value: LocalModelParameters[K]): void {
    if (!data || busy) return;
    void saveLocalModelPreferences({ ...data.preferences, parameters: { ...parameters, [key]: value } }).catch((cause) => setError(localModelError(cause)));
  }
  async function start(): Promise<void> {
    const names = compare ? [modelA, modelB] : [selected];
    if (names.some((n) => !n)) return;
    setSubmitting(true); setError(""); setHistoryRun(null);
    try { await localModelBridge().startLocalModelRun({ mode, models: names as string[], prompt, systemPrompt: system, parameters }); }
    catch (cause) { setError(localModelError(cause)); }
    finally { setSubmitting(false); }
  }
  async function stop(): Promise<void> { setStopping(true); try { await localModelBridge().stopLocalModelRun(); } catch (cause) { setError(localModelError(cause)); setStopping(false); } }
  function selectHistory(previous: LocalModelRun): void {
    if (previous.mode !== mode) {
      localModelDrafts[previous.mode] = { prompt: previous.prompt, systemPrompt: previous.systemPrompt };
      goToLab("local-model-lab", previous.mode);
      // The selected record can be reopened on the destination page; persist only actual preferences.
      historySelection = previous;
    } else { setHistoryRun(previous); setPrompt(previous.prompt); setSystem(previous.systemPrompt); setShowSystem(Boolean(previous.systemPrompt)); }
    if (data && !active) void saveLocalModelPreferences({ ...data.preferences, parameters: previous.parameters,
      ...(previous.mode === "compare" ? { modelA: previous.outputs[0]?.model ?? null, modelB: previous.outputs[1]?.model ?? null } : { selectedModel: previous.outputs[0]?.model ?? null }) }).catch((cause) => setError(localModelError(cause)));
  }
  useEffect(() => { if (historySelection?.mode === mode) { setHistoryRun(historySelection); historySelection = null; } }, [mode]);
  const canRun = Boolean(prompt.trim() && selected && (!compare || (modelA && modelB)) && data?.runtime.status === "ready" && !busy);
  return <section className="lm-page">
    <header className="lm-heading"><LabIcon labId="local-model-lab" /><h1>LOCAL MODEL LAB</h1><span>OLLAMA</span><small title="推理仅在本机进行，模型下载需要联网">LOCAL INFERENCE</small></header>
    <div className="lm-layout">
      <aside className="lm-models"><header className="lm-models__heading"><h2>INSTALLED MODELS</h2><button type="button" title="刷新模型与内存状态" aria-label="刷新模型" disabled={loading} onClick={() => void refreshLocalModels()} className="lm-small-icon">↻</button></header>
        <div className="lm-models__actions"><button type="button" className="lm-pull" onClick={() => setDialog("pull")}>↓ PULL MODEL</button>{compare && <div className="lm-target" aria-label="选择模型分配位置"><button type="button" disabled={busy} className={target === "A" ? "is-active" : ""} onClick={() => setTarget("A")} aria-pressed={target === "A"}>选 A</button><button type="button" disabled={busy} className={target === "B" ? "is-active is-b" : ""} onClick={() => setTarget("B")} aria-pressed={target === "B"}>选 B</button></div>}</div>
        <div className="lm-models__list">
          {models.map((model) => { const slot = compare ? model.name === modelA ? "A" : model.name === modelB ? "B" : null : model.name === selected ? "A" : null;
            return <article key={model.name} className={`lm-model${slot ? " is-selected" : ""}${compare && slot === "A" ? " is-a" : ""}${slot === "B" ? " is-b" : ""}`}><button type="button" className="lm-model__select" onClick={() => void chooseModel(model.name)} disabled={busy} aria-label={`选择模型 ${model.name}`} aria-pressed={Boolean(slot)}><LabIcon labId="local-model-lab" /><span><strong>{model.name}</strong><small>{formatBytes(model.size)} · {model.quantization}</small><em>{model.loaded ? `载入 ${formatBytes(model.memoryBytes)}` : `${model.parameterSize} · 已下载`}</em></span>{compare && slot && <b className={`lm-slot${slot === "B" ? " lm-slot--b" : ""}`}>{slot}</b>}</button><button className="lm-model__details" type="button" aria-label={`${model.name} 模型详情`} title="模型详情" onClick={() => setDetails(model)}>›</button></article>; })}
          {!models.length && <div className="lm-models-empty"><LabIcon labId="local-model-lab" /><strong>{loading ? "正在连接 Ollama…" : "还没有本地模型"}</strong><p>先下载一个文本模型，再开始实验。权重保存在本机，可离线运行。</p><button type="button" className="lm-secondary" onClick={() => setDialog("pull")}>下载第一个模型</button></div>}
        </div>
        {data?.download?.status === "downloading" && <button className="lm-download-mini" type="button" onClick={() => setDialog("pull")}><span className="lm-spinner" /><span><strong>{data.download.model}</strong><small>{data.download.total ? `${Math.floor((data.download.completed ?? 0) / data.download.total * 100)}% · ` : ""}{data.download.message}</small></span></button>}
        <footer className="lm-models__footer"><span>OLLAMA {data?.runtime.version ?? ""}</span><small>{models.length} 个模型 · {models.filter((m) => m.loaded).length} 个已载入</small></footer>
      </aside>
      <section className="lm-main"><nav className="lm-tabs" aria-label="本地模型实验视图"><button type="button" aria-current={!compare ? "page" : undefined} className={!compare ? "is-active" : ""} onClick={() => goToLab("local-model-lab", "playground")}>PLAYGROUND</button><button type="button" aria-current={compare ? "page" : undefined} className={compare ? "is-active" : ""} onClick={() => goToLab("local-model-lab", "compare")}>COMPARE</button><button type="button" className="lm-history-button" onClick={() => setDialog("history")}>历史 ↗</button></nav>
        <div className="lm-center-content">
          {(error || storeError || data?.runtime.error) && <div className="lm-error" role="alert"><span>{error || storeError || data?.runtime.error}</span><button type="button" onClick={() => { setError(""); void refreshLocalModels(); }}>重试</button></div>}
          <section className="lm-prompt"><div className="lm-section-label"><label htmlFor="lm-prompt">PROMPT</label><button type="button" disabled={busy} onClick={() => setPrompt("一个完全离线的桌面应用，为什么适合用 SQLite 保存本地数据？请用中文回答，最多三点。")}>试个例子</button></div>
            <div className="lm-prompt__box"><textarea id="lm-prompt" value={prompt} maxLength={32000} spellCheck={false} placeholder="输入要交给本地模型的问题…" onChange={(e) => { setPrompt(e.target.value); setHistoryRun(null); }} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canRun) { e.preventDefault(); void start(); } }} />
              {showSystem && <div className="lm-system"><label htmlFor="lm-system">SYSTEM PROMPT</label><textarea id="lm-system" value={system} maxLength={8192} placeholder="可选：约束回答方式或设定角色" onChange={(e) => setSystem(e.target.value)} /></div>}
              <div className="lm-prompt__actions"><button type="button" className={`lm-system-toggle${system ? " has-value" : ""}`} aria-expanded={showSystem} onClick={() => setShowSystem(!showSystem)}>{showSystem ? "−" : "+"} System prompt</button>
                {inThisMode || submitting ? <button className="lm-run lm-run--stop" type="button" disabled={stopping || submitting} onClick={() => void stop()}>■ {stopping ? "STOPPING…" : submitting ? "STARTING…" : "STOP RUN"}</button> : <button className="lm-run" type="button" disabled={!canRun} onClick={() => void start()}>▶ {compare ? "RUN COMPARISON" : "RUN PROMPT"}</button>}</div>
            </div><div className="lm-prompt__hint"><span>{active && !inThisMode ? `${active.mode === "compare" ? "Compare" : "Playground"} 正在运行，请先完成或停止` : compare ? "同一输入与参数 · 先 A 后 B · 每次加载后独立运行" : "独立实验 · 不携带上一轮上下文"}</span><kbd>⌘ ↵</kbd></div>
          </section>
          {historyRun && <div className="lm-record-strip"><span>查看记录 · {new Date(historyRun.createdAt).toLocaleString("zh-CN", { hour12: false })}</span><button type="button" onClick={() => setHistoryRun(null)}>回到最近运行</button></div>}
          <div className={`lm-outputs${compare ? " lm-outputs--compare" : ""}`}><ResponsePanel key={`${run?.id ?? mode}-a`} output={run?.outputs[0]} index={0} compare={compare} />{compare && <ResponsePanel key={`${run?.id ?? mode}-b`} output={run?.outputs[1]} index={1} compare />}</div>
        </div>
      </section>
      <aside className="lm-settings"><div className="lm-settings__scroll"><h2>{compare ? "SHARED SETTINGS" : "RUN SETTINGS"}</h2>
        <fieldset disabled={busy || !data}><div className="lm-setting"><label htmlFor="lm-temperature">Temperature <output>{parameters.temperature.toFixed(1)}</output></label><input id="lm-temperature" type="range" min="0" max="2" step="0.1" value={parameters.temperature} onChange={(e) => parameter("temperature", Number(e.target.value))} /></div>
          <div className="lm-setting"><label htmlFor="lm-context">Context length</label><div className="lm-stepper"><button type="button" aria-label="减少上下文长度" disabled={parameters.contextLength <= 512 || busy} onClick={() => parameter("contextLength", Math.max(512, Math.floor(parameters.contextLength / 2)))}>−</button><NumericInput id="lm-context" className="" min={512} max={131072} value={parameters.contextLength} onCommit={(n) => parameter("contextLength", n!)} /><button type="button" aria-label="增加上下文长度" disabled={parameters.contextLength >= 131072 || busy} onClick={() => parameter("contextLength", Math.min(131072, parameters.contextLength * 2))}>+</button></div></div>
          <div className="lm-setting"><label htmlFor="lm-seed">Seed <small>留空为 Auto</small></label><NumericInput id="lm-seed" min={0} max={2147483647} value={parameters.seed} nullable onCommit={(n) => parameter("seed", n)} /></div>
          <div className="lm-setting"><label htmlFor="lm-max-tokens">Max output <small>tokens</small></label><NumericInput id="lm-max-tokens" min={1} max={32768} value={parameters.maxTokens} onCommit={(n) => parameter("maxTokens", n!)} /></div>
          <div className="lm-setting"><label htmlFor="lm-thinking">Thinking</label><select id="lm-thinking" value={parameters.thinking} onChange={(e) => parameter("thinking", e.target.value as LocalModelParameters["thinking"])}><option value="auto">Auto · 模型默认</option><option value="off">Off · 支持时关闭</option></select></div>
        </fieldset>
        <section className={`lm-measurements${compare ? " lm-measurements--compare" : ""}`}><header><h2>MEASUREMENTS</h2>{compare && <span><b className="lm-slot">A</b><b className="lm-slot lm-slot--b">B</b></span>}</header><dl>{measurementRows.map((row) => <div key={row.title} title={row.tooltip}><dt>{row.title}</dt><dd>{row.display(run?.outputs[0]?.metrics)}</dd>{compare && <dd>{row.display(run?.outputs[1]?.metrics)}</dd>}</div>)}</dl><p>指标来自真实运行，未返回时显示 —。速度不代表回答质量。不同模型即使使用相同 Seed，也不保证输出相同。</p>{run && <div className="lm-run-evidence"><span>{historyRun ? "记录参数" : "本次运行参数"}</span><code>T {run.parameters.temperature} · C {run.parameters.contextLength} · Seed {run.parameters.seed ?? "Auto"}</code><small>Max {run.parameters.maxTokens} · Thinking {run.parameters.thinking}</small><time title={run.createdAt}>{new Date(run.createdAt).toLocaleString("zh-CN", { hour12: false })}</time></div>}</section>
      </div></aside>
    </div>
    {dialog === "pull" && <PullModelDialog onClose={() => setDialog(null)} />}{dialog === "history" && <ModelHistoryDialog onClose={() => setDialog(null)} onSelect={selectHistory} />}{details && <ModelDetailsDialog model={details} onClose={() => setDetails(null)} />}
  </section>;
}

let historySelection: LocalModelRun | null = null;
