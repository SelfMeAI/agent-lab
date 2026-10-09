import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from "react";
import type { LocalModelDetails, LocalModelDownload, LocalModelInfo, LocalModelRun } from "../../../../../../packages/contracts/src/local-model";
import { sameLocalModel } from "../../../../../../packages/runtime/src/ollama";
import { localModelBridge, deleteLocalModelRun, formatBytes, localModelError, localModelStatus, refreshLocalModels, useLocalModels } from "./local-model-store";
import { localModelCatalog } from "./model-catalog";
import { downloadInProgress, downloadPercent, downloadStatusLabel, formatDownloadRate, formatDownloadRemaining } from "./download-presentation";

export function LocalModelDialog({ title, children, onClose, wide = false, className = "" }: { title: string; children: ReactNode; onClose(): void; wide?: boolean; className?: string }): JSX.Element {
  const id = useId(); const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop lm-backdrop" onMouseDown={onClose}>
    <section ref={ref} className={`settings-panel lm-dialog${wide ? " lm-dialog--wide" : ""}${className ? ` ${className}` : ""}`} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} onMouseDown={(e) => e.stopPropagation()}>
      <header className="settings-panel__heading"><h2 id={id}>{title}</h2><button type="button" aria-label="关闭面板" onClick={onClose}>✕</button></header>
      <div className="settings-panel__body">{children}</div>
    </section>
  </div>;
}

export function LocalModelSettings({ onClose }: { onClose(): void }): JSX.Element {
  const { data } = useLocalModels(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function changeDirectory(): Promise<void> {
    setBusy(true); setError("");
    try { await localModelBridge().chooseLocalModelDirectory(); await refreshLocalModels(); } catch (cause) { setError(localModelError(cause)); } finally { setBusy(false); }
  }
  return <LocalModelDialog title="SETTINGS" onClose={onClose}>
    <div className="settings-panel__intro"><span>LOCAL MODEL CONFIGURATION</span><div className="settings-panel__title-row"><h3>Ollama 本地运行</h3><small>{data?.runtime.status === "ready" ? "已连接" : "未就绪"}</small></div><p>内置运行时，无需 API Key。推理和实验记录留在本机。</p></div>
    <dl><dt>版本</dt><dd>{data?.runtime.version ?? "—"}</dd><dt>模型数量</dt><dd>{data?.models.length ?? 0}</dd><dt>运行方式</dt><dd>本机推理 · 仅监听本机地址</dd></dl>
    <div className="settings-panel__field"><label>MODELS DIRECTORY</label><p className="lm-directory">{data?.modelsDirectory ?? "读取中…"}</p>
      <div className="lm-dialog-actions"><button className="lm-secondary" type="button" disabled={busy || !data || Boolean(data.activeRun) || downloadInProgress(data.download)} onClick={() => void changeDirectory()}>{busy ? "切换中…" : "更换目录"}</button><button className="lm-secondary" type="button" disabled={!data} onClick={() => void localModelBridge().openLocalModelDirectory().catch((cause) => setError(localModelError(cause)))}>打开目录</button></div>
    </div>
    <div className="settings-panel__note lm-note"><strong>存储说明</strong><p>更换目录不会移动或删除原模型。切回原目录即可继续使用；实验历史和默认参数不受影响。</p><p>模型下载需要联网，运行已下载的模型不需要联网。</p></div>
    {error && <p className="settings-panel__error" role="alert">{error}</p>}
  </LocalModelDialog>;
}

export function DownloadCard({ download, onClose }: { download: LocalModelDownload; onClose(): void }): JSX.Element {
  const { data } = useLocalModels(); const [operating, setOperating] = useState(false); const [error, setError] = useState("");
  const percent = downloadPercent(download), transitional = download.status === "pausing" || download.status === "cancelling";
  async function action(kind: "pause" | "resume" | "cancel" | "restart"): Promise<void> {
    if (operating || transitional) return;
    setOperating(true); setError("");
    try {
      const bridge = localModelBridge();
      if (kind === "pause") await bridge.pauseLocalModelDownload();
      if (kind === "resume") await bridge.resumeLocalModelDownload();
      if (kind === "cancel") await bridge.stopLocalModelDownload();
      if (kind === "restart") await bridge.pullLocalModel(download.model);
    } catch (cause) { setError(localModelError(cause)); } finally { setOperating(false); }
  }
  return <section className={`lm-download lm-download--${download.status}`} aria-label="当前模型下载">
    <header><strong title={download.model}>{download.model}</strong><span className="lm-download-status" aria-live="polite">{downloadStatusLabel(download)}</span></header>
    <span>{download.message}</span>
    {download.status !== "cancelled" && <progress aria-label="模型下载进度" aria-valuetext={`${downloadStatusLabel(download)}${percent === null ? "" : ` ${Math.floor(percent)}%`}`} max="100" {...(percent === null ? {} : { value: percent })} />}
    <div className="lm-download-metrics"><small>{percent === null ? "等待模型清单…" : `${formatBytes(download.completed)} / ${formatBytes(download.total)} · ${Math.floor(percent)}%`}</small>
      {download.status === "downloading" && download.message === "下载模型文件" && <small title="速度不包含已有缓存；剩余时间按已知文件估算">{formatDownloadRate(download.bytesPerSecond)}{formatDownloadRemaining(download.remainingSeconds) && ` · 剩余 ${formatDownloadRemaining(download.remainingSeconds)}`}</small>}
    </div>
    {(download.error || error) && <p className="settings-panel__error" role="alert">{error || download.error}</p>}
    <div className="lm-download-actions">
      {download.status === "downloading" && <button className="lm-secondary" type="button" disabled={operating} onClick={() => void action("pause")}>暂停</button>}
      {transitional && <button className="lm-secondary" type="button" disabled><i className="lm-spinner" />{download.status === "pausing" ? "正在暂停…" : "正在取消…"}</button>}
      {(download.status === "paused" || download.status === "error") && <button className="lm-secondary lm-secondary--primary" type="button" disabled={operating || data?.runtime.status !== "ready"} onClick={() => void action("resume")}>{operating ? "连接中…" : download.status === "error" ? "重试下载" : "继续下载"}</button>}
      {!['complete', 'cancelled'].includes(download.status) && <button className="lm-secondary" type="button" title="结束当前下载；共享缓存由 Ollama 管理，不会删除其他模型" disabled={operating || transitional} onClick={() => void action("cancel")}>取消下载</button>}
      {download.status === "cancelled" && <button className="lm-secondary" type="button" disabled={operating || data?.runtime.status !== "ready"} onClick={() => void action("restart")}>{operating ? "连接中…" : "重新下载"}</button>}
      {download.status === "complete" && <><button className="lm-secondary lm-secondary--primary" type="button" onClick={onClose}>返回实验</button><button className="lm-secondary" type="button" disabled={operating || data?.runtime.status !== "ready"} onClick={() => void action("restart")}>检查更新</button></>}
    </div>
    {download.status === "paused" && <p className="lm-download-note">已保存的分片可复用；继续时会重新核对缓存。关闭面板不影响下载记录。</p>}
  </section>;
}

export function PullModelDialog({ onClose, initialName }: { onClose(): void; initialName?: string }): JSX.Element {
  const { data, loading } = useLocalModels(); const [name, setName] = useState(initialName ?? data?.download?.model ?? "qwen3:0.6b"); const [error, setError] = useState(""); const [starting, setStarting] = useState(false);
  const [family, setFamily] = useState("all");
  const download = data?.download; const busy = starting || downloadInProgress(download);
  const installed = (model: string): boolean => Boolean(data?.models.some((item) => sameLocalModel(item.name, model)));
  const isInstalled = installed(name.trim());
  const paused = download?.status === "paused";
  const showDownload = download && download.status !== "complete" && (downloadInProgress(download) || paused
    || (sameLocalModel(download.model, name.trim()) && (download.status !== "cancelled" || !isInstalled)));
  const groups = family === "all" ? localModelCatalog : localModelCatalog.filter((group) => group.id === family);
  const selected = localModelCatalog.flatMap((group) => group.models).find((model) => model.name === name.trim());
  async function pull(): Promise<void> {
    if (busy) return;
    setError(""); setStarting(true);
    try { await localModelBridge().pullLocalModel(name.trim()); } catch (cause) { setError(localModelError(cause)); } finally { setStarting(false); }
  }
  return <LocalModelDialog title="PULL MODEL" onClose={onClose} className="lm-pull-dialog">
    <div className="settings-panel__intro"><span>LOCAL MODEL LIBRARY</span><div className="settings-panel__title-row"><h3>下载本地模型</h3><small>按需下载</small></div><p>选择 Ollama 型号或公开的 Hugging Face GGUF。大小是参考下载体积，不是运行内存。</p></div>
    {data?.runtime.status !== "ready" && <div className="lm-runtime-warning" role="status"><span>{loading ? "正在连接本地服务…" : "本地服务尚未就绪"}</span><button className="lm-secondary" type="button" disabled={loading} onClick={() => void refreshLocalModels()}>重试连接</button></div>}
    <form className="settings-panel__form" onSubmit={(e) => { e.preventDefault(); void pull(); }}>
      <div className="settings-panel__field"><label htmlFor="lm-pull-name">MODEL NAME</label><input id="lm-pull-name" value={name} onChange={(e) => { setName(e.target.value); setError(""); }} disabled={busy} maxLength={160} autoComplete="off" spellCheck={false} required placeholder="例如 qwen3:0.6b 或 hf.co/作者/仓库:量化" /></div>
      <div className="lm-catalog-filters" role="group" aria-label="按模型系列筛选">
        {[{ id: "all", title: "全部" }, ...localModelCatalog].map((group) => <button key={group.id} type="button" aria-pressed={family === group.id} className={family === group.id ? "is-active" : ""} onClick={() => setFamily(group.id)}>{group.title}</button>)}
      </div>
      <div className="lm-catalog-scroll" role="region" aria-label="小模型下载列表" tabIndex={0}>
        {groups.map((group) => <section className="lm-catalog-group" key={group.id} aria-labelledby={`lm-family-${group.id}`}>
          <header><h4 id={`lm-family-${group.id}`}>{group.title}</h4><span>{group.description}</span></header>
          <div className="lm-model-suggestions">{group.models.map((model) => <button key={model.name} type="button" disabled={busy} aria-pressed={sameLocalModel(name.trim(), model.name)} onClick={() => { setName(model.name); setError(""); }} className={sameLocalModel(name.trim(), model.name) ? "is-selected" : ""}>
            <span className="lm-catalog-model-heading"><strong>{model.title}</strong><span className="lm-catalog-size">≈ {formatBytes(model.downloadBytes)}</span></span>
            <code>{model.name}</code><small>{model.note}</small>
            <span className="lm-catalog-badges"><span className="lm-catalog-badge">{model.availability === "huggingface" ? "Hugging Face · GGUF" : "Ollama"}</span>{installed(model.name) && <span className="lm-catalog-badge is-installed">已下载</span>}</span>
          </button>)}</div>
        </section>)}
      </div>
      <div className="lm-catalog-submit"><p>{paused ? "请继续或取消当前暂停的下载，再下载其他模型。" : isInstalled && !showDownload ? "已下载，可直接运行。检查更新会保留现有模型。" : "下载完成后，模型会出现在左侧列表。暂停或重试会复用已下载文件。"}{!isInstalled && (selected?.availability === "huggingface" || name.trim().toLowerCase().startsWith("hf.co/")) && " GGUF 的可运行性取决于模型架构和运行时支持。"}</p>{!paused && !showDownload && <button className="settings-panel__save" disabled={busy || !name.trim() || data?.runtime.status !== "ready"} type="submit">{starting ? "连接中…" : isInstalled ? "检查模型更新" : "下载模型"}</button>}</div>
    </form>
    {showDownload && <DownloadCard download={download} onClose={onClose} />}
    {error && <p className="settings-panel__error" role="alert">{error}</p>}
  </LocalModelDialog>;
}

export function ModelDetailsDialog({ model, onClose }: { model: LocalModelInfo; onClose(): void }): JSX.Element {
  const { data } = useLocalModels(); const [details, setDetails] = useState<LocalModelDetails | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { let current = true; void localModelBridge().getLocalModelDetails(model.name).then((d) => { if (current) setDetails(d); }).catch((cause) => { if (current) setError(localModelError(cause)); }); return () => { current = false; }; }, [model.name]);
  const live = data?.models.find((m) => m.name === model.name) ?? model;
  async function operation(remove: boolean): Promise<void> { setBusy(true); setError(""); try { if (remove) await localModelBridge().deleteLocalModel(model.name); else await localModelBridge().unloadLocalModel(model.name); await refreshLocalModels(); if (remove) onClose(); } catch (cause) { setError(localModelError(cause)); } finally { setBusy(false); } }
  return <LocalModelDialog title="MODEL DETAILS" onClose={onClose}>
    <div className="settings-panel__intro"><span>LOCAL MODEL</span><div className="settings-panel__title-row"><h3>{model.name}</h3></div><p>{live.loaded ? `已载入 · ${formatBytes(live.memoryBytes)}` : "已下载 · 未载入内存"}</p></div>
    <dl><dt>文件大小</dt><dd>{formatBytes(model.size)}</dd><dt>参数规模</dt><dd>{model.parameterSize}</dd><dt>量化</dt><dd>{model.quantization}</dd><dt>最大上下文</dt><dd>{details?.contextLength?.toLocaleString() ?? "—"}</dd><dt>能力</dt><dd>{details?.capabilities.join(" · ") ?? "读取中…"}</dd></dl>
    <div className="settings-panel__field"><label>DIGEST</label><code className="lm-directory">{model.digest}</code></div>
    <div className="lm-dialog-actions"><button className="lm-secondary" type="button" disabled={busy || Boolean(data?.activeRun) || !live.loaded || (downloadInProgress(data?.download) && sameLocalModel(data!.download!.model, model.name))} onClick={() => void operation(false)}>释放内存</button><button className="lm-secondary lm-danger" type="button" disabled={busy || Boolean(data?.activeRun) || downloadInProgress(data?.download)} onClick={() => setConfirmDelete(true)}>删除模型</button></div>
    {confirmDelete && <div className="lm-confirm"><p>删除本地的 {model.name}？之后需要重新下载。已有实验记录会保留。</p><button type="button" className="lm-secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button><button type="button" className="lm-secondary lm-danger" disabled={busy} onClick={() => void operation(true)}>{busy ? "删除中…" : "确认删除"}</button></div>}
    {error && <p className="settings-panel__error" role="alert">{error}</p>}
  </LocalModelDialog>;
}

export function ModelHistoryDialog({ onClose, onSelect }: { onClose(): void; onSelect(run: LocalModelRun): void }): JSX.Element {
  const { data } = useLocalModels(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState<string | null>(null);
  async function select(id: string): Promise<void> { setBusy(true); try { onSelect(await localModelBridge().getLocalModelRun(id)); onClose(); } catch (cause) { setError(localModelError(cause)); } finally { setBusy(false); } }
  async function remove(id: string): Promise<void> { setBusy(true); try { await deleteLocalModelRun(id); setConfirm(null); } catch (cause) { setError(localModelError(cause)); } finally { setBusy(false); } }
  return <LocalModelDialog title="EXPERIMENT HISTORY" onClose={onClose} wide>
    <div className="settings-panel__intro"><span>LOCAL EXPERIMENTS</span><div className="settings-panel__title-row"><h3>实验记录</h3><small>{data?.history.length ?? 0} 条</small></div><p>保留输入、参数、模型版本、完整输出与指标。打开记录不会自动重新运行。</p></div>
    {!data?.history.length && <p className="lm-history-empty">还没有实验记录，运行一次提示词即可保存。</p>}
    <div className="lm-history-list">{data?.history.map((run) => <article key={run.id}><button type="button" disabled={busy} onClick={() => void select(run.id)}><span>{run.mode === "compare" ? "COMPARE" : "PLAYGROUND"}<small>{localModelStatus[run.status]}</small></span><strong>{run.prompt}</strong><em>{run.models.join(" / ")}</em><time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString("zh-CN", { hour12: false })}</time></button>
      {run.id !== data.activeRun?.id && <div className="lm-history-delete">{confirm === run.id ? <><span>删除此记录？</span><button type="button" disabled={busy} onClick={() => void remove(run.id)}>确认</button><button type="button" onClick={() => setConfirm(null)}>取消</button></> : <button type="button" aria-label={`删除实验 ${run.prompt.slice(0, 20)}`} onClick={() => setConfirm(run.id)}>删除</button>}</div>}
    </article>)}</div>{data && data.history.length === 200 && <p className="lm-hint">显示最近 200 条，全部记录仍保存在本机数据库。</p>}
    {error && <p className="settings-panel__error" role="alert">{error}</p>}
  </LocalModelDialog>;
}
