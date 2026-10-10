/// <reference path="./novnc.d.ts" />
import { useEffect, useRef, useState, type JSX } from "react";
import type RFB from "@novnc/novnc";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { RemoteAgentId, RemoteBrowserOptions, RemoteBrowserTab, RemoteDesktopGrant, RemoteFilePage, RemoteFilePreview, RemoteTaskSnapshot, RemoteTerminal, RemoteTerminalEvent } from "../../../../../../packages/contracts/src/remote-agent";
import { remoteError } from "./service-presentation";
import { browserFrame, browserReconnectOptions, desktopInputEnabled, followBrowserTab, observerLabel, remoteCommandItems } from "./scene-presentation";
import { desktopInputBoundary } from "./desktop-input";

type Tab = "desktop" | "browser" | "terminal" | "files" | "preview";
const tabLabels = { desktop: ["Desktop", "桌面"], browser: ["Browser", "浏览器"], terminal: ["Terminal", "终端"], files: ["Files", "文件"], preview: ["Preview", "产物"] };
export function remoteFileSize(size: number): string { return size < 1024 ? size + " B" : size < 1024 * 1024 ? (size / 1024).toFixed(1) + " KB" : (size / 1024 / 1024).toFixed(1) + " MB"; }
export function RemoteScene({ engine, taskId, snapshot, available, returning, onReturningChange }: { engine: RemoteAgentId; taskId: string; snapshot?: RemoteTaskSnapshot; available: boolean; returning: boolean; onReturningChange(value: boolean): void }): JSX.Element {
  const bridge = window.selfmeLab!;
  const [tab, setTab] = useState<Tab>(engine === "openclaw" ? "desktop" : "browser"); const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<{ path: string; value: RemoteFilePreview }>(); const [previewError, setPreviewError] = useState(""); const previewVersion = useRef(0); const [previewLoading, setPreviewLoading] = useState(false);
  const tabs: Tab[] = engine === "openclaw" ? ["desktop", "browser", "terminal", "files", "preview"] : ["browser", "terminal", "files", "preview"];
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, []);
  useEffect(() => () => { ++previewVersion.current; }, [engine, taskId]);
  useEffect(() => { if (returning && snapshot?.humanControl) setTab("desktop"); }, [returning, snapshot?.humanControl]);
  async function openPreview(path: string): Promise<void> { const version = ++previewVersion.current; setPreviewError(""); setPreview(undefined); setPreviewLoading(true); setTab("preview"); try { const value = await bridge.previewRemoteTaskFile(engine, taskId, path); if (version === previewVersion.current) setPreview({ path, value }); } catch (error) { if (version === previewVersion.current) setPreviewError(remoteError(error)); } finally { if (version === previewVersion.current) setPreviewLoading(false); } }
  const disabled = !taskId || !available;
  return <section className={`remote-scene${expanded ? " is-expanded" : ""}`} aria-label="远端执行现场"><header className="remote-scene__heading"><h2>远端现场</h2>{expanded && snapshot?.humanControl && <><span className="remote-scene__control-label">人工接管中</span><button type="button" className="remote-button remote-control-return" onClick={() => onReturningChange(true)}>交还智能体</button></>}<button type="button" className="remote-icon-button" aria-label={expanded ? "退出展开" : "展开执行现场"} title={expanded ? "退出展开 · Esc" : "展开执行现场"} onClick={() => setExpanded(!expanded)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={expanded ? "M8 3v5H3m18 0h-5V3M3 16h5v5m8 0v-5h5" : "M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5"} /></svg></button></header><nav className="remote-scene__tabs" role="tablist" aria-label="执行现场视图">{tabs.map(id => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{tabLabels[id][0]}<span> · {tabLabels[id][1]}</span></button>)}</nav>
    <div className="remote-scene__content">
      {disabled ? <div className="remote-scene-empty"><span>◈</span><p>{taskId ? "连接远端服务后查看执行现场" : "选择或新建任务，观察远端执行现场"}</p></div> : <>
        {/* Preserve a controlled framebuffer while viewing files/terminal. */}
        {(tab === "desktop" || snapshot?.humanControl) && engine === "openclaw" && <div className={`remote-scene-view${tab !== "desktop" ? " is-hidden" : ""}`}><RemoteDesktop engine={engine} taskId={taskId} humanControl={snapshot?.humanControl ?? false} returning={returning} onReturningChange={onReturningChange} onBrowser={() => setTab("browser")} /></div>}
        {tab === "browser" && (engine === "openhands" ? <RemoteDesktop engine={engine} taskId={taskId} humanControl={false} returning={returning} onReturningChange={onReturningChange} /> : <RemoteBrowser taskId={taskId} running={snapshot?.task.status === "running"} controlled={snapshot?.humanControl ?? false} onDesktop={() => setTab("desktop")} />)}
        {tab === "terminal" && <RemoteTerminalPanel engine={engine} taskId={taskId} snapshot={snapshot} onDesktop={() => setTab("desktop")} />}
        {tab === "files" && <RemoteFiles engine={engine} taskId={taskId} running={snapshot?.task.status === "running"} onPreview={path => void openPreview(path)} />}
        {tab === "preview" && <div className="remote-preview">
          {previewError && <p className="remote-error">{previewError}</p>}
          {previewLoading ? <div className="remote-scene-empty"><span className="remote-spinner" /><p>正在读取远端产物…</p></div> : preview ? <>
            <header title={preview.path}><strong>{preview.path.split("/").pop()}</strong><button type="button" className="remote-button" onClick={() => void bridge.downloadRemoteTaskFile(engine, taskId, preview.path).catch(error => setPreviewError(remoteError(error)))}>下载</button><button type="button" className="remote-icon-button" aria-label="刷新产物预览" title="刷新预览" onClick={() => void openPreview(preview.path)}>↻</button></header>
            {preview.value.kind === "text" ? <pre>{preview.value.text}</pre> : preview.value.kind === "image" ? <div className="remote-preview__image"><img src={preview.value.url} alt={preview.path} /></div> : preview.value.kind === "html" || preview.value.kind === "pdf" ? <iframe key={preview.value.url} src={preview.value.url} title={`产物预览：${preview.path}`} sandbox={preview.value.kind === "pdf" ? undefined : "allow-scripts"} referrerPolicy="no-referrer" /> : <div className="remote-scene-empty"><p>此文件无法直接预览，下载后可以使用本地应用打开</p></div>}
            {preview.value.truncated && <small className="remote-scene-note">仅预览前 1 MB，下载可获得完整内容</small>}
          </> : <div className="remote-scene-empty"><span>▤</span><p>从文件列表选择图片、网页或文档</p><button className="remote-button" type="button" onClick={() => setTab("files")}>查看远端文件</button></div>}
        </div>}
      </>}
    </div><footer className="remote-scene__footer"><span>ⓘ</span>远端执行 · 文件通过上传和下载交换</footer>
  </section>;
}
function RemoteDesktop({ engine, taskId, humanControl, onBrowser, returning, onReturningChange: setReturning }: { engine: RemoteAgentId; taskId: string; humanControl: boolean; onBrowser?(): void; returning: boolean; onReturningChange(value: boolean): void }): JSX.Element {
  const bridge = window.selfmeLab!; const host = useRef<HTMLDivElement>(null); const framebuffer = useRef<RFB | undefined>(undefined);
  const [grant, setGrant] = useState<RemoteDesktopGrant>(); const [state, setState] = useState<"loading" | "connected" | "error">("loading"); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState(false); const [followUp, setFollowUp] = useState("");
  const alive = useRef(true); const [size, setSize] = useState("");
  const inputBoundary = useRef<ReturnType<typeof desktopInputBoundary> | undefined>(undefined);
  const inputEnabled = desktopInputEnabled(engine === "openclaw" && humanControl, grant?.control === true, state, busy, confirm || returning);
  useEffect(() => {
    if (!host.current) return;
    const boundary = desktopInputBoundary(host.current); inputBoundary.current = boundary;
    return () => { boundary.dispose(); if (inputBoundary.current === boundary) inputBoundary.current = undefined; };
  }, [engine, taskId]);
  useEffect(() => { alive.current = true; void bridge.observeRemoteDesktop(engine, taskId, false).then(value => { if (alive.current) setGrant(value); }).catch(error => { if (alive.current) { setState("error"); setError(remoteError(error)); } }); return () => { alive.current = false; framebuffer.current?.disconnect(); }; }, [engine, taskId]);
  useEffect(() => {
    if (!inputEnabled) inputBoundary.current?.release();
    if (framebuffer.current) framebuffer.current.viewOnly = !inputEnabled;
  }, [inputEnabled, grant]);
  useEffect(() => {
    if (!grant || !host.current) return;
    setState("loading"); setError("");
    let cancelled = false; let rfb: RFB | undefined; let dimensions: MutationObserver | undefined;
    const timeout = setTimeout(() => { if (!cancelled) { setState("error"); setError("远端画面连接超时，请重新连接；任务不会因此丢失。"); rfb?.disconnect(); } }, 20_000);
    const connected = () => { clearTimeout(timeout); setState("connected"); }, disconnected = () => { clearTimeout(timeout); inputBoundary.current?.release(); setState("error"); setError("观察连接已断开，可以重新连接；任务仍在远端。" ); };
    const security = (event: Event) => { setState("error"); setError((event as CustomEvent).detail?.reason || "远端画面认证失败"); };
    void import("@novnc/novnc").then(({ default: Framebuffer }) => {
      if (cancelled || !host.current) return;
      rfb = new Framebuffer(host.current, grant.url, { credentials: { password: grant.password }, shared: true }); framebuffer.current = rfb;
      rfb.viewOnly = true; rfb.showDotCursor = true; rfb.scaleViewport = true; rfb.resizeSession = false; rfb.qualityLevel = 9; rfb.compressionLevel = 2; rfb.background = "#05090d";
      rfb.addEventListener("connect", connected); rfb.addEventListener("disconnect", disconnected); rfb.addEventListener("securityfailure", security);
      const measure = () => { const canvas = host.current?.querySelector("canvas"); if (canvas?.width && canvas.height) setSize(`${canvas.width} × ${canvas.height} · 适应窗口`); };
      dimensions = new MutationObserver(measure); dimensions.observe(host.current, { childList: true, subtree: true, attributes: true, attributeFilter: ["width", "height"] }); measure();
    }).catch(error => { if (!cancelled) { setState("error"); setError(remoteError(error)); } });
    return () => { cancelled = true; clearTimeout(timeout); dimensions?.disconnect(); inputBoundary.current?.release(); if (rfb) { rfb.removeEventListener("connect", connected); rfb.removeEventListener("disconnect", disconnected); rfb.removeEventListener("securityfailure", security); rfb.disconnect(); if (framebuffer.current === rfb) framebuffer.current = undefined; } };
  }, [grant]);
  async function observe(control: boolean): Promise<void> { if (busy) return; inputBoundary.current?.release(); setBusy(true); setError(""); framebuffer.current?.disconnect(); try { const next = await bridge.observeRemoteDesktop(engine, taskId, control); if (alive.current) { setGrant(next); setConfirm(false); } } catch (error) { if (alive.current) { setError(remoteError(error)); setState("error"); } } finally { if (alive.current) setBusy(false); } }
  async function handBack(continueWork: boolean): Promise<void> { if (busy) return; inputBoundary.current?.release(); setBusy(true); framebuffer.current?.disconnect(); try { const next = await bridge.returnRemoteDesktop(engine, taskId, continueWork ? followUp.trim() || "继续当前任务。" : undefined); if (alive.current) { setGrant(next); setReturning(false); setFollowUp(""); } } catch (error) { if (alive.current) { setError(remoteError(error)); setState("error"); } } finally { if (alive.current) setBusy(false); } }
  const controlled = humanControl;
  return <div className="remote-desktop">
    <div className="remote-observer-bar">
      <span className={`remote-observer-status is-${state}`}>{state === "loading" || busy ? <i className="remote-spinner" /> : <i />}{observerLabel(state, busy, controlled)}</span>
      {onBrowser && <button type="button" className="remote-button" title={controlled ? "交还智能体后可打开浏览器" : undefined} disabled={busy || controlled} onClick={onBrowser}>打开浏览器</button>}
      {engine === "openclaw" && <button type="button" className={`remote-button${controlled ? " remote-button--danger" : ""}`} disabled={busy || (!controlled && state !== "connected")} onClick={() => controlled ? setReturning(true) : setConfirm(true)}>{controlled ? "交还智能体" : "接管"}</button>}
      <button type="button" className="remote-icon-button" aria-label="重新连接远端画面" title="重新连接" disabled={busy} onClick={() => void observe(Boolean(controlled))}>↻</button>
    </div>
    <div className="remote-rfb-stage">
      <div ref={host} className={`remote-rfb${inputEnabled ? "" : " is-view-only"}`} title={inputEnabled ? "控制远端桌面" : "只读观察 · 鼠标与键盘不会操作远端"} />
      {(state !== "connected" || busy) && <div className="remote-rfb-overlay">{state === "loading" || busy ? <><span className="remote-spinner" /><p>{busy ? "正在准备远端连接…" : "正在连接远端画面…"}</p></> : <><p>{error}</p><button type="button" className="remote-button" onClick={() => void observe(Boolean(controlled))} disabled={busy}>重新连接</button></>}</div>}
    </div>
    {size && <small className="remote-frame-size">{size} · 可展开查看</small>}
    {error && state === "connected" && <p className="remote-error">{error}</p>}
    <small className="remote-scene-note">{engine === "openhands" ? "引擎共享浏览器画面 · 智能体打开网页后在此显示 · 只读观察" : controlled ? "智能体工具操作已阻止 · 鼠标与键盘控制远端容器，不操作你的电脑" : "引擎共享桌面 · 浏览器和桌面应用在此显示 · 命令与文件另见对应页签"}</small>
    {grant?.warning && <p className="remote-error" role="alert">{grant.warning}</p>}
    {confirm && <div className="remote-inline-confirm" role="dialog" aria-label="确认接管远端桌面"><h3>接管远端桌面</h3><p>将停止此引擎正在执行的任务，并阻止新的工具操作。确认停稳后，鼠标和键盘才会交给你。</p><div><button type="button" className="remote-button" disabled={busy} onClick={() => setConfirm(false)}>取消</button><button type="button" className="remote-button remote-button--primary" disabled={busy} onClick={() => void observe(true)}>{busy ? "正在停止…" : "停止并接管"}</button></div></div>}
    {returning && <div className="remote-inline-confirm" role="dialog" aria-label="交还远端桌面"><h3>交还智能体</h3><p>重新同步现场后，可以等待新指令，或明确让智能体继续。</p><textarea rows={3} aria-label="交还后的补充要求" placeholder="刚才做了什么，接下来希望怎么继续（可选）" value={followUp} onChange={event => setFollowUp(event.target.value)} /><div><button type="button" className="remote-button" disabled={busy} onClick={() => setReturning(false)}>取消</button><button type="button" className="remote-button" disabled={busy} onClick={() => void handBack(false)}>交还，等待指令</button><button type="button" className="remote-button remote-button--primary" disabled={busy} onClick={() => void handBack(true)}>交还并继续</button></div></div>}
  </div>;
}
function RemoteBrowser({ taskId, running, controlled, onDesktop }: { taskId: string; running?: boolean; controlled: boolean; onDesktop(): void }): JSX.Element {
  const bridge = window.selfmeLab!, socket = useRef<WebSocket | undefined>(undefined);
  const alive = useRef(true), latest = useRef(""), connecting = useRef(false), generation = useRef(0), attempts = useRef(0);
  const frameTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); const target = useRef(""); const seenTabs = useRef(new Set<string>());
  const [image, setImage] = useState(""); const [url, setUrl] = useState(""); const [address, setAddress] = useState("");
  const [status, setStatus] = useState("正在准备远端浏览器…"); const [connected, setConnected] = useState(false); const [busy, setBusy] = useState(true);
  const [tabs, setTabs] = useState<RemoteBrowserTab[]>([]); const [size, setSize] = useState("");
  const [focusing, setFocusing] = useState(false); const [focusError, setFocusError] = useState("");
  async function showDesktop(): Promise<void> {
    if (busy || focusing || controlled || !target.current) return;
    const version = generation.current; setFocusing(true); setFocusError("");
    try {
      await bridge.focusRemoteBrowser("openclaw", taskId, target.current);
      if (alive.current && version === generation.current) onDesktop();
    } catch (error) { if (alive.current && version === generation.current) setFocusError(remoteError(error)); }
    finally { if (alive.current && version === generation.current) setFocusing(false); }
  }
  async function connect(options: RemoteBrowserOptions = {}): Promise<void> {
    if (controlled) { setBusy(false); setStatus("正在人工接管，请交还后重新连接任务页面"); return; }
    if (connecting.current) return;
    connecting.current = true; const version = ++generation.current;
    setBusy(true); setConnected(false); setStatus("正在连接任务页面…"); setFocusError("");
    clearTimeout(frameTimeout.current); const old = socket.current; socket.current = undefined; old?.close();
    if (latest.current) URL.revokeObjectURL(latest.current); latest.current = ""; setImage(""); setSize("");
    try {
      const grant = await bridge.observeRemoteBrowser("openclaw", taskId, options);
      if (!alive.current || version !== generation.current) return;
      target.current = grant.targetId; seenTabs.current = new Set(grant.tabs.map(tab => tab.targetId));
      setTabs(grant.tabs); setUrl(grant.pageUrl); setAddress(grant.pageUrl === "about:blank" ? "" : grant.pageUrl);
      const ws = new WebSocket(grant.url); socket.current = ws; ws.binaryType = "arraybuffer";
      const current = () => alive.current && socket.current === ws && version === generation.current;
      let failureMessage = "";
      frameTimeout.current = setTimeout(() => { if (current()) { setBusy(false); setStatus("浏览器未传回画面，请重新连接"); ws.close(); } }, 20_000);
      ws.onmessage = event => {
        if (!current()) return;
        try {
          if (typeof event.data === "string") {
            const packet = JSON.parse(event.data);
            if (packet.type === "ready" || packet.type === "meta") { if (typeof packet.url === "string") setUrl(packet.url); }
            if (packet.type === "error") throw new Error(packet.message || "浏览器观察失败");
            return;
          }
          const frame = browserFrame(event.data as ArrayBuffer);
          if (frame.url) setUrl(frame.url);
          const src = URL.createObjectURL(new Blob([Uint8Array.from(frame.jpeg).buffer], { type: "image/jpeg" }));
          if (latest.current) URL.revokeObjectURL(latest.current); latest.current = src;
          clearTimeout(frameTimeout.current); attempts.current = 0; setImage(src); setConnected(true); setBusy(false); setStatus("LIVE · 只读观察");
        } catch (error) { failureMessage = remoteError(error); clearTimeout(frameTimeout.current); setBusy(false); setStatus(failureMessage); ws.close(); }
      };
      ws.onclose = () => { if (current()) { clearTimeout(frameTimeout.current); setConnected(false); setBusy(false); setStatus(failureMessage || (attempts.current >= 3 ? "观察连接已断开，请重新连接" : "观察连接已断开，正在尝试重新连接…")); } };
      ws.onerror = () => { if (current()) { setBusy(false); setStatus("浏览器画面连接失败，请重新连接"); } };
    } catch (error) { if (alive.current && version === generation.current) { setStatus(remoteError(error)); setBusy(false); } }
    finally { if (version === generation.current) connecting.current = false; }
  }
  async function reconnect(openIfMissing = false): Promise<void> {
    if (connecting.current || controlled) return;
    const version = generation.current;
    setBusy(true);
    try {
      const currentTabs = await bridge.listRemoteBrowserTabs("openclaw", taskId);
      if (!alive.current || version !== generation.current || controlled) return;
      const options = browserReconnectOptions(currentTabs, target.current, openIfMissing);
      if (!options) {
        // The user or agent may intentionally close the browser. An observer
        // retry must not undo that action by silently launching a new one.
        attempts.current = 3; setBusy(false); setStatus("此任务的浏览器页面已关闭，点击重新连接可打开新页面"); return;
      }
      await connect(options);
    } catch (error) { if (alive.current && version === generation.current) { setBusy(false); setStatus(remoteError(error)); } }
  }
  useEffect(() => {
    alive.current = true; void connect();
    return () => { alive.current = false; ++generation.current; connecting.current = false; clearTimeout(frameTimeout.current); socket.current?.close(); if (latest.current) URL.revokeObjectURL(latest.current); latest.current = ""; };
  }, [taskId]);
  useEffect(() => {
    if (connected || busy || controlled || attempts.current >= 3) return;
    const retry = setTimeout(() => { ++attempts.current; void reconnect(); }, 2500 * (attempts.current + 1));
    return () => clearTimeout(retry);
  }, [taskId, connected, busy, controlled, status]);
  useEffect(() => {
    if (focusing) return;
    let current = true, querying = false;
    const query = () => {
      if (querying || connecting.current) return; querying = true;
      void bridge.listRemoteBrowserTabs("openclaw", taskId).then(value => {
        if (!current) return; setTabs(value); const newest = followBrowserTab(seenTabs.current, value, target.current);
        seenTabs.current = new Set(value.map(tab => tab.targetId));
        if (newest && newest !== target.current && !controlled) void connect({ targetId: newest });
      }).catch(() => {}).finally(() => { querying = false; });
    };
    // Also synchronize on completion: a short final tool can open a page and
    // finish before the next interval tick.
    query(); const timer = running ? setInterval(query, 3000) : undefined;
    return () => { current = false; clearInterval(timer); };
  }, [taskId, running, controlled, focusing]);
  return <div className="remote-browser">
    <div className="remote-observer-bar"><span className={`remote-observer-status is-${connected ? "connected" : busy ? "loading" : "error"}`}>{busy ? <i className="remote-spinner" /> : <i />}{connected ? "LIVE · 只读观察" : busy ? "正在连接浏览器…" : "浏览器观察未连接"}</span><button type="button" className="remote-button" disabled={!connected || busy || focusing || controlled} onClick={() => void showDesktop()}>{focusing ? "正在定位…" : "在桌面查看"}</button><button type="button" className="remote-icon-button" aria-label="刷新浏览器观察" title="重新连接此任务页面" disabled={busy || focusing || controlled} onClick={() => { attempts.current = 0; void reconnect(true); }}>↻</button></div>
    {focusError && <p className="remote-error">{focusError}</p>}
    <form className="remote-browser-address" onSubmit={event => { event.preventDefault(); if (address.trim() && !busy && !focusing && !controlled) { attempts.current = 0; void connect({ url: address.trim() }); } }}><input aria-label="远端浏览器地址" type="url" placeholder="https://… 在远端浏览器打开" value={address} disabled={busy || focusing || controlled} onChange={event => setAddress(event.target.value)} /><button type="submit" className="remote-button" disabled={busy || focusing || controlled || !address.trim()}>打开</button></form>
    {tabs.length > 1 && <select className="remote-browser-tab-select" aria-label="选择任务浏览器页面" value={target.current} disabled={busy || focusing || controlled} onChange={event => void connect({ targetId: event.target.value })}>{tabs.map(tab => <option key={tab.targetId} value={tab.targetId}>{tab.title || tab.url || "新页面"}</option>)}</select>}
    {url && <div className="remote-browser-url" title={url}>{url}</div>}
    <div className="remote-browser-screen">{image && <img src={image} alt="远端浏览器实时画面" onLoad={event => { const image = event.currentTarget; setSize(`${image.naturalWidth} × ${image.naturalHeight} · 适应窗口`); }} />}{!connected && <div className="remote-rfb-overlay">{busy && <span className="remote-spinner" />}<p>{status}</p>{!busy && <button type="button" className="remote-button" onClick={() => { attempts.current = 0; void connect(); }}>重新连接</button>}</div>}</div>
    {size && <small className="remote-frame-size">{size} · 可展开查看</small>}<small className="remote-scene-note">只展示当前任务的网页 · 与远端桌面使用同一浏览器 · 不操作你的电脑</small>
  </div>;
}
function RemoteFiles({ engine, taskId, running, onPreview }: { engine: RemoteAgentId; taskId: string; running?: boolean; onPreview(path: string): void }): JSX.Element {
  const [directory, setDirectory] = useState(""); const [page, setPage] = useState<RemoteFilePage>(); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const generation = useRef(0);
  async function refresh(showBusy = true): Promise<void> { const version = ++generation.current; if (showBusy) setBusy(true); try { const result = await window.selfmeLab!.listRemoteTaskFiles(engine, taskId, directory); if (version === generation.current) { setPage(result); setError(""); } } catch (error) { if (version === generation.current) setError(remoteError(error)); } finally { if (version === generation.current) setBusy(false); } }
  useEffect(() => { void refresh(); const timer = running ? setInterval(() => void refresh(false), 3000) : undefined; return () => { ++generation.current; clearInterval(timer); }; }, [engine, taskId, directory, running]);
  return <div className="remote-files"><header><button type="button" className="remote-icon-button" disabled={!directory} aria-label="返回上层远端目录" title="上层目录" onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}>↑</button><span title={directory}>/{directory || "任务文件"}</span><button type="button" className="remote-icon-button" aria-label="刷新远端文件" title="刷新文件" onClick={() => void refresh()} disabled={busy}>↻</button></header>{error && <p className="remote-error">{error}</p>}<div className="remote-files__list">{busy && !page ? <div className="remote-scene-empty"><span className="remote-spinner" /></div> : page?.files.length ? [...page.files].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).map(file => <div key={file.path} className="remote-file-row"><button type="button" className="remote-file-name" title={file.name} onClick={() => file.directory ? setDirectory(file.path) : onPreview(file.path)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={file.directory ? "M2 6h8l2 2h10v12H2z" : "M5 2h9l5 5v15H5zM14 2v6h5M8 12h8m-8 4h8"} /></svg><span>{file.name}<small>{file.directory ? "目录" : remoteFileSize(file.size)}</small></span></button>{!file.directory && <button type="button" className="remote-icon-button" aria-label={`下载：${file.name}`} title="下载文件" onClick={() => void window.selfmeLab!.downloadRemoteTaskFile(engine, taskId, file.path).catch(error => setError(remoteError(error)))}>↓</button>}</div>) : <div className="remote-scene-empty"><span>▤</span><p>任务还没有生成文件</p></div>}</div>{page?.truncated && <small className="remote-scene-note">此目录仅显示前 500 项，请进入子目录查看</small>}</div>;
}
function RemoteTerminalPanel({ engine, taskId, snapshot, onDesktop }: { engine: RemoteAgentId; taskId: string; snapshot?: RemoteTaskSnapshot; onDesktop(): void }): JSX.Element {
  const [administration, setAdministration] = useState(false);
  const tools = remoteCommandItems(snapshot?.items ?? []);
  return <div className="remote-terminal-panel"><div className="remote-terminal-tabs"><button type="button" aria-pressed={!administration} onClick={() => setAdministration(false)}>智能体输出{tools.length ? ` · ${tools.length}` : ""}</button>{engine === "openclaw" && <button type="button" aria-pressed={administration} onClick={() => setAdministration(true)}>交互终端</button>}</div>{administration ? <AdminTerminal taskId={taskId} onDesktop={onDesktop} /> : <div className="remote-agent-console">{tools.length ? tools.map(item => <div key={item.id}><header><span className={item.tool!.status === "running" ? "remote-spinner" : ""}>{item.tool!.status === "completed" ? "✓" : item.tool!.status === "failed" ? "!" : ""}</span>{item.tool!.title}<span className="remote-console-state">{item.tool!.status === "running" ? "执行中" : item.tool!.status === "completed" ? "已完成" : "未完成"}</span></header>{item.tool!.input && <pre className="remote-command">$ {item.tool!.name === "ls" ? "ls " : ""}{item.tool!.input}</pre>}{item.tool!.output ? <pre>{item.tool!.output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")}</pre> : <p className="remote-console-pending">{item.tool!.status === "running" ? "等待远端命令输出…" : "此命令没有文本输出"}</p>}</div>) : <div className="remote-scene-empty"><span>›_</span><p>此任务还没有执行终端命令<br />执行记录会随智能体操作更新，不是连接故障</p>{engine === "openclaw" && <button type="button" className="remote-button" onClick={() => setAdministration(true)}>打开交互终端</button>}</div>}</div>}</div>;
}
function AdminTerminal({ taskId, onDesktop }: { taskId: string; onDesktop(): void }): JSX.Element {
  const bridge = window.selfmeLab!; const host = useRef<HTMLDivElement>(null); const terminal = useRef<Terminal | undefined>(undefined); const current = useRef<RemoteTerminal | undefined>(undefined); const alive = useRef(true);
  const opening = useRef(false), generation = useRef(0), pending = useRef<RemoteTerminalEvent[]>([]); const fitTerminal = useRef<(() => void) | undefined>(undefined);
  const [info, setInfo] = useState<RemoteTerminal>(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [ended, setEnded] = useState(false);
  useEffect(() => { alive.current = true; const term = new Terminal({ fontSize: 12, fontFamily: "Menlo, monospace", cursorBlink: true, scrollback: 5000, theme: { background: "#060b0f", foreground: "#c4d1d9", cursor: "#f28b7b", selectionBackground: "#f28b7b35" } }); const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current!); terminal.current = term;
    const size = () => { if (!host.current?.clientHeight) return; fit.fit(); if (current.current) void bridge.resizeRemoteTerminal("openclaw", taskId, current.current.id, term.cols, term.rows).catch(error => { if (alive.current) setError(remoteError(error)); }); };
    fitTerminal.current = size;
    const observer = new ResizeObserver(size); observer.observe(host.current!); const initialFit = requestAnimationFrame(size);
    const input = term.onData(data => { if (current.current) void bridge.inputRemoteTerminal("openclaw", taskId, current.current.id, data).catch(error => { if (alive.current) setError(remoteError(error)); }); });
    const unsubscribe = bridge.onRemoteTerminalEvent(event => {
      if (event.taskId !== taskId || event.engine !== "openclaw") return;
      // terminal.open/attach may already emit prompt/output before IPC returns
      // its id. Buffer only this opening window and replay for the exact id.
      if (opening.current && !current.current) { pending.current = [...pending.current.slice(-255), event]; return; }
      if (event.terminalId !== current.current?.id) return;
      if (event.data) term.write(event.data);
      if (event.exited) { current.current = undefined; setEnded(true); term.writeln("\r\n[远端终端已结束]"); if (event.detail) setError(event.detail); }
    });
    void open();
    return () => { alive.current = false; ++generation.current; opening.current = false; pending.current = []; cancelAnimationFrame(initialFit); observer.disconnect(); input.dispose(); unsubscribe(); if (current.current) void bridge.closeRemoteTerminal("openclaw", taskId, current.current.id).catch(() => {}); current.current = undefined; terminal.current = undefined; fitTerminal.current = undefined; term.dispose(); };
  }, [taskId]);
  async function open(): Promise<void> {
    if (opening.current || current.current) return;
    opening.current = true; const version = ++generation.current; pending.current = []; setBusy(true); setError("");
    try {
      const result = await bridge.openRemoteTerminal("openclaw", taskId);
      if (!alive.current || version !== generation.current) { await bridge.closeRemoteTerminal("openclaw", taskId, result.id); return; }
      current.current = result; setInfo(result); setEnded(false); terminal.current?.reset();
      if (result.buffer) terminal.current?.write(result.buffer);
      for (const event of pending.current) if (event.terminalId === result.id) { if (event.data) terminal.current?.write(event.data); if (event.exited) { current.current = undefined; setEnded(true); } }
      pending.current = []; fitTerminal.current?.(); terminal.current?.focus();
    } catch (error) { if (alive.current && version === generation.current) setError(remoteError(error)); }
    finally { if (alive.current && version === generation.current) { opening.current = false; setBusy(false); } }
  }
  async function close(): Promise<void> { if (!current.current || busy) return; setBusy(true); try { await bridge.closeRemoteTerminal("openclaw", taskId, current.current.id); current.current = undefined; setEnded(true); } catch (error) { setError(remoteError(error)); } finally { setBusy(false); } }
  return <div className="remote-admin-terminal"><div className="remote-terminal-bar"><span title={info?.cwd}>{info && !ended ? info.cwd : "当前任务的远端终端"}</span>{info && !ended && <button type="button" className="remote-button" onClick={onDesktop}>查看桌面</button>}<button type="button" className="remote-button" disabled={busy} onClick={() => void (info && !ended ? close() : open())}>{busy ? "连接中…" : info && !ended ? "断开连接" : "重新连接"}</button></div><small className="remote-scene-note">与桌面终端共享同一会话，切换视图不会结束命令。直接执行你的命令，不经过智能体审批；智能体命令另见「智能体输出」。</small>{error && <p className="remote-error">{error}</p>}<div ref={host} className="remote-xterm" />{!info && !error && <div className="remote-terminal-intro"><p>正在连接当前任务的终端…</p></div>}</div>;
}
