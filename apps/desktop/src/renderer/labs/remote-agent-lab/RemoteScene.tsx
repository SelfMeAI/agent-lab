/// <reference path="./novnc.d.ts" />
import { useEffect, useRef, useState, type JSX } from "react";
import type RFB from "@novnc/novnc";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { RemoteAgentId, RemoteDesktopGrant, RemoteFilePage, RemoteFilePreview, RemoteTaskSnapshot, RemoteTerminal, RemoteTerminalAccess, RemoteTerminalEvent } from "../../../../../../packages/contracts/src/remote-agent";
import { remoteError } from "./service-presentation";
import { desktopInputEnabled, observerLabel, remoteSceneTabs, sceneTabDescription, terminalConnectionNotice } from "./scene-presentation";
import { desktopInputBoundary } from "./desktop-input";
import { isTerminalProtocolReply } from "../../../../../../packages/remote-agent/src/terminal-response";
import { remotePreviewKind } from "../../../../../../packages/remote-agent/src/file-preview";

type Tab = "desktop" | "browser" | "terminal" | "files" | "preview";
const tabLabels = { desktop: ["Desktop", "桌面"], browser: ["Browser", "浏览器"], terminal: ["Terminal", "人工终端"], files: ["Files", "文件"], preview: ["Preview", "产物"] };
export function remoteFileSize(size: number): string { return size < 1024 ? size + " B" : size < 1024 * 1024 ? (size / 1024).toFixed(1) + " KB" : (size / 1024 / 1024).toFixed(1) + " MB"; }
export function RemoteScene({ engine, taskId, snapshot, available }: { engine: RemoteAgentId; taskId: string; snapshot?: RemoteTaskSnapshot; available: boolean }): JSX.Element {
  const bridge = window.selfmeLab!;
  const [tab, setTab] = useState<Tab>(engine === "openclaw" ? "desktop" : "browser"); const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<{ path: string; value: RemoteFilePreview }>(); const [previewPath, setPreviewPath] = useState(""); const [previewError, setPreviewError] = useState(""); const previewVersion = useRef(0); const [previewLoading, setPreviewLoading] = useState(false);
  const disabled = !taskId || !available;
  const tabs = remoteSceneTabs(engine);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, []);
  useEffect(() => () => { ++previewVersion.current; }, [engine, taskId]);
  async function openPreview(path: string): Promise<void> { const version = ++previewVersion.current; setPreviewPath(path); setPreviewError(""); setPreview(undefined); setPreviewLoading(true); setTab("preview"); try { const value = await bridge.previewRemoteTaskFile(engine, taskId, path); if (version === previewVersion.current) setPreview({ path, value }); } catch (error) { if (version === previewVersion.current) setPreviewError(remoteError(error)); } finally { if (version === previewVersion.current) setPreviewLoading(false); } }
  return <section className={`remote-scene${expanded ? " is-expanded" : ""}`} aria-label="远端执行现场"><header className="remote-scene__heading"><h2>远端现场</h2><button type="button" className="remote-icon-button" aria-label={expanded ? "收起视图" : "展开查看"} title={expanded ? "收起视图 · Esc" : "展开查看"} onClick={() => setExpanded(!expanded)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={expanded ? "M8 3v5H3m18 0h-5V3M3 16h5v5m8 0v-5h5" : "M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5"} /></svg></button></header>
    <nav className="remote-scene__tabs" role="tablist" aria-label="执行现场视图">{tabs.map(id => <button key={id} type="button" role="tab" aria-selected={tab === id} title={sceneTabDescription(engine, id)} onClick={() => setTab(id)}>{tabLabels[id][0]}<span> · {tabLabels[id][1]}</span></button>)}</nav>
    <div className="remote-scene__content">
      {disabled ? <div className="remote-scene-empty"><span>◈</span><p>{taskId ? "连接远端服务后查看执行现场" : "选择或新建任务，观察远端执行现场"}</p></div> : <>
        {/* Keep one desktop connection across views, without accepting hidden input. */}
        {engine === "openclaw" && <div className={`remote-scene-view${tab !== "desktop" ? " is-hidden" : ""}`}><RemoteDesktop engine={engine} taskId={taskId} active={tab === "desktop" && snapshot?.connection === "connected"} /></div>}
        {engine === "openhands" && tab === "browser" && <RemoteDesktop engine={engine} taskId={taskId} />}
        {engine === "openclaw" && tab === "terminal" && <AdminTerminal taskId={taskId} />}
        {tab === "files" && <RemoteFiles engine={engine} taskId={taskId} running={snapshot?.task.status === "running"} onPreview={path => void openPreview(path)} />}
        {tab === "preview" && <div className="remote-preview">
          {previewPath && <header title={previewPath}><strong>{previewPath.split("/").pop()}</strong><button type="button" className="remote-button" onClick={() => void bridge.downloadRemoteTaskFile(engine, taskId, previewPath).catch(error => setPreviewError(remoteError(error)))}>{remotePreviewKind(previewPath) === "office" ? "下载原文件" : "下载"}</button><button type="button" className="remote-icon-button" aria-label="刷新产物预览" title="刷新预览" disabled={previewLoading} onClick={() => void openPreview(previewPath)}>↻</button></header>}
          {previewError && preview && <p className="remote-error" role="alert">{previewError}</p>}
          {previewLoading ? <div className="remote-scene-empty" role="status"><span className="remote-spinner" /><p>{remotePreviewKind(previewPath) === "office" ? "正在生成文档预览…" : "正在读取远端产物…"}</p></div> : preview ? <>
            {preview.value.kind === "text" ? <pre>{preview.value.text}</pre> : preview.value.kind === "image" ? <div className="remote-preview__image"><img src={preview.value.url} alt={preview.path} /></div> : preview.value.kind === "html" || preview.value.kind === "pdf" ? <iframe key={preview.value.url} src={preview.value.url} title={`产物预览：${preview.path}`} sandbox={preview.value.kind === "pdf" ? undefined : "allow-scripts"} referrerPolicy="no-referrer" /> : <div className="remote-scene-empty"><p>此文件无法直接预览，下载后可以使用本地应用打开</p></div>}
            {preview.value.truncated && <small className="remote-scene-note">仅预览前 1 MB，下载可获得完整内容</small>}
          </> : previewError ? <div className="remote-scene-empty"><span>▤</span><p className="remote-error" role="alert">{previewError}</p><button className="remote-button" type="button" onClick={() => void openPreview(previewPath)}>重试预览</button></div> : <div className="remote-scene-empty"><span>▤</span><p>从文件列表选择文档、表格、演示文稿、图片或网页</p><button className="remote-button" type="button" onClick={() => setTab("files")}>查看远端文件</button></div>}
        </div>}
      </>}
    </div>
  </section>;
}
function RemoteDesktop({ engine, taskId, active = false }: { engine: RemoteAgentId; taskId: string; active?: boolean }): JSX.Element {
  const bridge = window.selfmeLab!; const host = useRef<HTMLDivElement>(null); const framebuffer = useRef<RFB | undefined>(undefined);
  const [grant, setGrant] = useState<RemoteDesktopGrant>();
  const [state, setState] = useState<"loading" | "connected" | "error">("loading"); const [error, setError] = useState("");
  const alive = useRef(true); const [size, setSize] = useState("");
  const inputBoundary = useRef<ReturnType<typeof desktopInputBoundary> | undefined>(undefined);
  const inputEnabled = desktopInputEnabled(engine === "openclaw" && active, grant?.control === true, state);
  const connectInput = useRef(false);
  connectInput.current = desktopInputEnabled(engine === "openclaw" && active, grant?.control === true, "connected");
  useEffect(() => {
    if (!host.current) return;
    const boundary = desktopInputBoundary(host.current); inputBoundary.current = boundary;
    return () => { boundary.dispose(); if (inputBoundary.current === boundary) inputBoundary.current = undefined; };
  }, [engine, taskId]);
  async function observe(): Promise<void> { setState("loading"); setError(""); try { const value = await bridge.observeRemoteDesktop(engine, taskId); if (alive.current) setGrant(value); } catch (cause) { if (alive.current) { setState("error"); setError(remoteError(cause)); } } }
  useEffect(() => { alive.current = true; void observe(); return () => { alive.current = false; inputBoundary.current?.release(); framebuffer.current?.disconnect(); }; }, [engine, taskId]);
  useEffect(() => {
    if (!inputEnabled) inputBoundary.current?.release();
    if (framebuffer.current) framebuffer.current.viewOnly = !inputEnabled;
  }, [inputEnabled, grant]);
  useEffect(() => {
    if (!grant || !host.current) return;
    setState("loading"); setError("");
    let cancelled = false; let rfb: RFB | undefined; let dimensions: MutationObserver | undefined;
    const timeout = setTimeout(() => { if (!cancelled) { setState("error"); setError("远端画面连接超时，请重新连接；任务不会因此丢失。"); rfb?.disconnect(); } }, 20_000);
    // A fast replacement connection can leave React's state at "connected".
    // Apply permission to this new RFB instance, not only in a state effect.
    const connected = () => { clearTimeout(timeout); if (rfb) rfb.viewOnly = !connectInput.current; setState("connected"); }, disconnected = () => { clearTimeout(timeout); inputBoundary.current?.release(); setState("error"); setError("远端画面连接已断开，可以重新连接；任务仍在远端。" ); };
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
  return <div className="remote-desktop">
    <div className="remote-observer-bar">
      <span className={`remote-observer-status is-${state}`}>{state === "loading" ? <i className="remote-spinner" /> : <i />}{observerLabel(state, inputEnabled)}</span>
    </div>
    <div className="remote-rfb-stage">
      <div ref={host} className={`remote-rfb${inputEnabled ? "" : " is-view-only"}`} title={inputEnabled ? "控制远端桌面" : "只读观察 · 鼠标与键盘不会操作远端"} />
      {state !== "connected" && <div className="remote-rfb-overlay">{state === "loading" ? <><span className="remote-spinner" /><p>正在连接远端画面…</p></> : <><p>{error}</p><button type="button" className="remote-button" onClick={() => void observe()}>重新连接</button></>}</div>}
    </div>
    {size && <small className="remote-frame-size">{size}</small>}
    {error && state === "connected" && <p className="remote-error">{error}</p>}
  </div>;
}
function RemoteFiles({ engine, taskId, running, onPreview }: { engine: RemoteAgentId; taskId: string; running?: boolean; onPreview(path: string): void }): JSX.Element {
  const [directory, setDirectory] = useState(""); const [page, setPage] = useState<RemoteFilePage>(); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const generation = useRef(0);
  async function refresh(showBusy = true): Promise<void> { const version = ++generation.current; if (showBusy) setBusy(true); try { const result = await window.selfmeLab!.listRemoteTaskFiles(engine, taskId, directory); if (version === generation.current) { setPage(result); setError(""); } } catch (error) { if (version === generation.current) setError(remoteError(error)); } finally { if (version === generation.current) setBusy(false); } }
  useEffect(() => { void refresh(); const timer = running ? setInterval(() => void refresh(false), 3000) : undefined; return () => { ++generation.current; clearInterval(timer); }; }, [engine, taskId, directory, running]);
  return <div className="remote-files"><header><button type="button" className="remote-icon-button" disabled={!directory} aria-label="返回上层远端目录" title="上层目录" onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}>↑</button><span title={directory}>/{directory || "任务文件"}</span><button type="button" className="remote-icon-button" aria-label="刷新远端文件" title="刷新文件" onClick={() => void refresh()} disabled={busy}>↻</button></header>{error && <p className="remote-error">{error}</p>}<div className="remote-files__list">{busy && !page ? <div className="remote-scene-empty"><span className="remote-spinner" /></div> : page?.files.length ? [...page.files].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).map(file => <div key={file.path} className="remote-file-row"><button type="button" className="remote-file-name" title={file.name} onClick={() => file.directory ? setDirectory(file.path) : onPreview(file.path)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={file.directory ? "M2 6h8l2 2h10v12H2z" : "M5 2h9l5 5v15H5zM14 2v6h5M8 12h8m-8 4h8"} /></svg><span>{file.name}<small>{file.directory ? "目录" : remoteFileSize(file.size)}</small></span></button>{!file.directory && <button type="button" className="remote-icon-button" aria-label={`下载：${file.name}`} title="下载文件" onClick={() => void window.selfmeLab!.downloadRemoteTaskFile(engine, taskId, file.path).catch(error => setError(remoteError(error)))}>↓</button>}</div>) : <div className="remote-scene-empty"><span>▤</span><p>此目录暂无文件</p></div>}</div>{page?.truncated && <small className="remote-scene-note">此目录仅显示前 500 项，请进入子目录查看</small>}</div>;
}
function AdminTerminal({ taskId }: { taskId: string }): JSX.Element {
  const bridge = window.selfmeLab!; const host = useRef<HTMLDivElement>(null); const terminal = useRef<Terminal | undefined>(undefined); const current = useRef<RemoteTerminal | undefined>(undefined); const alive = useRef(true);
  const opening = useRef(false), generation = useRef(0), pending = useRef<RemoteTerminalEvent[]>([]); const fitTerminal = useRef<(() => void) | undefined>(undefined);
  const [info, setInfo] = useState<RemoteTerminal>(); const [error, setError] = useState(""); const [busy, setBusy] = useState(true); const [ended, setEnded] = useState(false);
  const [access, setAccess] = useState<RemoteTerminalAccess>();
  const [accessError, setAccessError] = useState("");
  const writable = access?.inputAllowed === true && !!info && !busy && !ended;
  const notice = terminalConnectionNotice({ connecting: busy, connected: !!info, ended, error, accessError, access });
  const inputAllowed = useRef(writable); inputAllowed.current = writable;
  useEffect(() => {
    let active = true, querying = false;
    setAccess(undefined); setAccessError("");
    async function refresh(): Promise<void> {
      if (querying) return; querying = true;
      try {
        const state = await bridge.getRemoteTerminalAccess("openclaw", taskId);
        if (active) { setAccess(state); setAccessError(""); }
      } catch (cause) { if (active) { setAccess(undefined); setAccessError(remoteError(cause)); } }
      finally { querying = false; }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [taskId]);
  useEffect(() => { if (terminal.current) { terminal.current.options.disableStdin = !writable; terminal.current.options.cursorBlink = writable; } }, [writable]);
  useEffect(() => { alive.current = true; setInfo(undefined); setEnded(false); setError(""); const term = new Terminal({ fontSize: 12, fontFamily: "Menlo, monospace", disableStdin: !inputAllowed.current, cursorBlink: inputAllowed.current, scrollback: 5000, theme: { background: "#060b0f", foreground: "#c4d1d9", cursor: "#f28b7b", selectionBackground: "#f28b7b35" } }); const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current!); terminal.current = term;
    const size = () => { if (!host.current?.clientHeight) return; fit.fit(); if (current.current) void bridge.resizeRemoteTerminal("openclaw", taskId, current.current.id, term.cols, term.rows).catch(error => { if (alive.current) setError(remoteError(error)); }); };
    fitTerminal.current = size;
    const observer = new ResizeObserver(size); observer.observe(host.current!); const initialFit = requestAnimationFrame(size);
    const input = term.onData(data => { if ((inputAllowed.current || isTerminalProtocolReply(data)) && current.current) void bridge.inputRemoteTerminal("openclaw", taskId, current.current.id, data).catch(error => { if (alive.current) setError(remoteError(error)); }); });
    const unsubscribe = bridge.onRemoteTerminalEvent(event => {
      if (event.taskId !== taskId || event.engine !== "openclaw") return;
      // terminal.open/attach may already emit prompt/output before IPC returns
      // its id. Buffer only this opening window and replay for the exact id.
      if (opening.current && !current.current) { pending.current = [...pending.current.slice(-255), event]; return; }
      if (event.terminalId !== current.current?.id) return;
      if (event.data) term.write(event.data);
      if (event.exited) { current.current = undefined; setEnded(true); if (event.detail) setError(event.detail); }
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
      for (const event of pending.current) if (event.terminalId === result.id) { if (event.data) terminal.current?.write(event.data); if (event.exited) { current.current = undefined; setEnded(true); if (event.detail) setError(event.detail); } }
      pending.current = []; fitTerminal.current?.(); terminal.current?.focus();
    } catch (error) { if (alive.current && version === generation.current) setError(remoteError(error)); }
    finally { if (alive.current && version === generation.current) { opening.current = false; setBusy(false); } }
  }
  return <div className={`remote-admin-terminal${writable ? "" : " is-readonly"}`}>
    {notice && <div className="remote-terminal-notice" role={error || accessError || notice.reconnect ? "alert" : "status"}><span>{notice.message}</span>{notice.reconnect && <button type="button" className="remote-button" onClick={() => void open()}>重新连接</button>}</div>}
    <div ref={host} className="remote-xterm" />
    {busy && <div className="remote-terminal-intro"><span className="remote-spinner" /><p>正在连接远端终端…</p></div>}
  </div>;
}
