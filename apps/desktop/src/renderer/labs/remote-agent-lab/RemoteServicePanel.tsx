import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from "react";
import { remoteAgentIds, type RemoteAgentId, type RemoteModelConnection, type RemoteModelProtocol } from "../../../../../../packages/contracts/src/remote-agent";
import brandMark from "../../../../../../assets/brand/selfme-lab-mark.png";
import { remoteEngines, RemoteMark, ServiceStatus, type ServiceBusy, type ServiceStates } from "./RemoteAgentPage";
import { remoteError } from "./service-presentation";
import { knownRemoteVision } from "../../../../../../packages/remote-agent/src/model-capabilities";

type Draft = { protocol: RemoteModelProtocol; baseUrl: string; model: string; apiKey: string; configured: boolean; supportsImages: boolean; dirty: boolean };
function initialDraft(): Draft { return { protocol: "openai", baseUrl: "https://api.deepseek.com", model: "", apiKey: "", configured: false, supportsImages: false, dirty: false }; }
function fromConnection(value: RemoteModelConnection): Draft { return { ...value, supportsImages: value.supportsImages ?? knownRemoteVision(value.baseUrl, value.model) ?? false, apiKey: "", dirty: false }; }

export function RemoteServicePanel({ initialEngine, states, busy, errors, onControl, onClose }: {
  initialEngine: RemoteAgentId; states: ServiceStates; busy: ServiceBusy; errors: Partial<Record<RemoteAgentId, string>>;
  onControl(id: RemoteAgentId, action: "start" | "stop" | "restart"): Promise<void>; onClose(): void;
}): JSX.Element {
  const [engine, setEngine] = useState(initialEngine);
  const [drafts, setDrafts] = useState<Record<RemoteAgentId, Draft>>({ openhands: initialDraft(), openclaw: initialDraft() });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visibleKey, setVisibleKey] = useState(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [logsOpen, setLogsOpen] = useState(false); const [logs, setLogs] = useState(""); const [logsLoading, setLogsLoading] = useState(false);
  const [confirm, setConfirm] = useState<{ id: RemoteAgentId; action: "stop" | "restart" } | null>(null);
  const panelRef = useRef<HTMLElement>(null); const alive = useRef(true);
  const close = useRef(onClose); close.current = onClose;
  const titleId = useId(); const draft = drafts[engine];
  const ready = states[engine]?.phase === "ready";

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panelRef.current)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { alive.current = false; document.removeEventListener("keydown", key); previous?.focus(); };
  }, []);

  useEffect(() => {
    let current = true;
    setVisibleKey(false); setError(""); setNotice(""); setLogsOpen(false); setLogs("");
    if (!ready || busy[engine] || !window.selfmeLab) { setLoading(false); return; }
    setLoading(true);
    void window.selfmeLab.getRemoteModelConnection(engine).then(value => {
      if (current) setDrafts(previous => ({ ...previous, [engine]: previous[engine].dirty ? previous[engine] : fromConnection(value) }));
    }).catch(cause => { if (current) setError(remoteError(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [engine, ready, busy[engine]]);

  function change<K extends "protocol" | "baseUrl" | "model" | "apiKey" | "supportsImages">(key: K, value: Draft[K]): void {
    setDrafts(previous => { const next = { ...previous[engine], [key]: value, dirty: true }; if (key === "model" || key === "baseUrl") next.supportsImages = knownRemoteVision(next.baseUrl, next.model) ?? false; return { ...previous, [engine]: next }; }); setNotice("");
  }
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault(); if (!window.selfmeLab || saving || !ready) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const value = await window.selfmeLab.saveRemoteModelConnection(engine, { protocol: draft.protocol, baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey || undefined, supportsImages: draft.supportsImages });
      if (alive.current) { setDrafts(previous => ({ ...previous, [engine]: fromConnection(value) })); setNotice("已保存到服务端 · 后续新任务使用此连接"); }
    } catch (cause) { if (alive.current) setError(remoteError(cause)); }
    finally { if (alive.current) setSaving(false); }
  }
  async function loadLogs(): Promise<void> {
    if (!window.selfmeLab || logsLoading) return;
    const selected = engine; setLogsLoading(true);
    try { const value = await window.selfmeLab.getRemoteServiceLogs(selected); if (alive.current) setLogs(value || "暂无服务日志"); }
    catch (cause) { if (alive.current) setLogs(remoteError(cause)); }
    finally { if (alive.current) setLogsLoading(false); }
  }
  function serviceAction(id: RemoteAgentId, action: "start" | "stop" | "restart"): void {
    if (action !== "start" && states[id]?.running) setConfirm({ id, action });
    else void onControl(id, action);
  }

  return <div className="remote-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panelRef} className="remote-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="remote-panel__header"><img src={brandMark} alt="" /><h2 id={titleId}>远端服务</h2><button type="button" aria-label="关闭服务面板" className="remote-panel__close" onClick={onClose}>×</button></header>
      <form className="remote-panel__form" onSubmit={event => void save(event)}>
        <div className="remote-panel__body">
          <h3>服务管理</h3>
          <div className="remote-service-rows">{remoteAgentIds.map(id => {
            const state = states[id]; const working = busy[id] || ["starting", "stopping"].includes(state?.phase ?? "");
            return <div className="remote-service-row" key={id}>
              <RemoteMark engine={id} /><div className="remote-service-row__copy"><strong>{remoteEngines[id].name}<small>{state?.version}</small></strong><ServiceStatus state={state} /></div>
              <div className="remote-service-row__actions">
                {state?.running ? <><button type="button" className="remote-button" disabled={working || saving} onClick={() => serviceAction(id, "stop")}>■ 停止</button><button type="button" className="remote-button" disabled={working || saving} onClick={() => serviceAction(id, "restart")}>↻ 重启</button></>
                  : <button type="button" className="remote-button" disabled={!state || working || saving || !state.dockerAvailable || !state.imageReady} onClick={() => serviceAction(id, "start")}>{working ? <><i className="remote-spinner" />处理中…</> : "▷ 启动"}</button>}
              </div>
              {(errors[id] || state?.setupWarning || (state && state.phase !== "ready" && state.phase !== "stopped" && !working) || (state && !state.imageReady)) && <p className="remote-service-row__detail">{errors[id] || state?.setupWarning || state?.detail}{state?.dockerAvailable && !state.imageReady && ` · npm run remote:build -- ${id}`}</p>}
            </div>;
          })}</div>
          {confirm ? <div className="remote-confirm" role="alert"><p>{confirm.action === "stop" ? "停止" : "重启"} {remoteEngines[confirm.id].name} 会中断当前执行，服务端数据不会删除。</p><div><button type="button" className="remote-button" onClick={() => setConfirm(null)}>取消</button><button type="button" className="remote-button remote-button--danger" onClick={() => { const action = confirm; setConfirm(null); void onControl(action.id, action.action); }}>确认{confirm.action === "stop" ? "停止" : "重启"}</button></div></div>
            : <p className="remote-panel__hint">ⓘ 停止或重启会影响当前任务，关闭应用不停止远端服务。</p>}
          <section className="remote-model-section" aria-labelledby="remote-model-heading">
            <h3 id="remote-model-heading">模型连接</h3>
            <div className="remote-model-tabs" role="tablist" aria-label="选择服务的模型连接">{remoteAgentIds.map(id => <button type="button" key={id} role="tab" aria-selected={engine === id} disabled={saving} onClick={() => setEngine(id)}>{remoteEngines[id].name}</button>)}</div>
            {!ready && <p className="remote-panel__hint">启动 {remoteEngines[engine].name} 后可读取和保存连接。</p>}
            <fieldset className="remote-model-fields" disabled={!ready || loading || saving || busy[engine]}>
              <label><span>协议</span><select value={draft.protocol} onChange={event => change("protocol", event.target.value as RemoteModelProtocol)}><option value="openai">OpenAI Compatible</option><option value="anthropic">Anthropic Messages</option></select></label>
              <label><span>Base URL</span><input value={draft.baseUrl} type="url" required autoComplete="off" placeholder="https://api.deepseek.com" onChange={event => change("baseUrl", event.target.value)} /></label>
              <label><span>API Key</span><span className="remote-key-field"><input value={draft.apiKey} type={visibleKey ? "text" : "password"} autoComplete="off" spellCheck={false} required={!draft.configured} placeholder={draft.configured ? "已保存，留空保持不变" : "输入 API Key"} onChange={event => change("apiKey", event.target.value)} /><button type="button" aria-label={visibleKey ? "隐藏 API Key" : "显示 API Key"} onClick={() => setVisibleKey(value => !value)}>{visibleKey ? "隐藏" : "显示"}</button></span></label>
              <label><span>Model ID</span><input value={draft.model} required autoComplete="off" placeholder="输入模型 ID" onChange={event => change("model", event.target.value)} /></label>
              <label className="remote-model-vision"><span>图像输入</span><span><input type="checkbox" checked={draft.supportsImages} onChange={event => change("supportsImages", event.target.checked)} />此模型支持读取图片</span></label>
            </fieldset>
            <p className="remote-panel__hint">ⓘ 观察画面不需要视觉模型；智能体识图操作需要模型支持图像输入。</p>
            {loading && <p className="remote-panel__hint"><i className="remote-spinner" />正在读取服务端连接…</p>}
            {error && <p className="remote-error" role="alert">{error}</p>}
            {notice && <p className="remote-panel__notice" role="status">{notice}</p>}
          </section>
          <div className="remote-logs"><button className="remote-logs__toggle" type="button" aria-expanded={logsOpen} onClick={() => { setLogsOpen(value => !value); if (!logsOpen) void loadLogs(); }}><span>{logsOpen ? "⌄" : "›"}</span>运行日志 <small>{remoteEngines[engine].name}</small></button>
            {logsOpen && <><div className="remote-logs__toolbar"><span>最近 100 行 · 凭据已隐藏</span><button type="button" disabled={logsLoading} onClick={() => void loadLogs()}>刷新</button></div><pre tabIndex={0} aria-label="服务运行日志">{logsLoading ? "正在读取日志…" : logs}</pre></>}
          </div>
        </div>
        <footer className="remote-panel__footer"><button type="button" className="remote-button" onClick={onClose}>关闭</button><button type="submit" className="remote-button remote-button--primary" disabled={!ready || loading || saving || busy[engine]}>{saving ? <><i className="remote-spinner" />保存中…</> : "保存连接"}</button></footer>
      </form>
    </section>
  </div>;
}
