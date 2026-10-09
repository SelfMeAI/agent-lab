/// <reference path="./novnc.d.ts" />
import { useEffect, useRef, useState, type JSX } from "react";
import type RFB from "@novnc/novnc";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { RemoteAgentId, RemoteDesktopGrant, RemoteFilePage, RemoteFilePreview, RemoteTaskSnapshot, RemoteTerminal } from "../../../../../../packages/contracts/src/remote-agent";
import { remoteError } from "./service-presentation";

type Tab = "desktop" | "browser" | "terminal" | "files" | "preview";
const tabLabels = { desktop: ["Desktop", "桌面"], browser: ["Browser", "浏览器"], terminal: ["Terminal", "终端"], files: ["Files", "文件"], preview: ["Preview", "产物"] };
export function remoteFileSize(size: number): string { return size < 1024 ? size + " B" : size < 1024 * 1024 ? (size / 1024).toFixed(1) + " KB" : (size / 1024 / 1024).toFixed(1) + " MB"; }
export function RemoteScene({ engine, taskId, snapshot, available }: { engine: RemoteAgentId; taskId: string; snapshot?: RemoteTaskSnapshot; available: boolean }): JSX.Element {
  const bridge = window.selfmeLab!;
  const [tab, setTab] = useState<Tab>(engine === "openclaw" ? "desktop" : "browser"); const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<{ path: string; value: RemoteFilePreview }>(); const [previewError, setPreviewError] = useState(""); const previewVersion = useRef(0); const [previewLoading, setPreviewLoading] = useState(false);
  const tabs: Tab[] = engine === "openclaw" ? ["desktop", "browser", "terminal", "files", "preview"] : ["browser", "terminal", "files", "preview"];
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, []);
  useEffect(() => () => { ++previewVersion.current; }, [engine, taskId]);
  async function openPreview(path: string): Promise<void> { const version = ++previewVersion.current; setPreviewError(""); setPreview(undefined); setPreviewLoading(true); setTab("preview"); try { const value = await bridge.previewRemoteTaskFile(engine, taskId, path); if (version === previewVersion.current) setPreview({ path, value }); } catch (error) { if (version === previewVersion.current) setPreviewError(remoteError(error)); } finally { if (version === previewVersion.current) setPreviewLoading(false); } }
  const disabled = !taskId || !available;
  return <section className={`remote-scene${expanded ? " is-expanded" : ""}`} aria-label="远端执行现场"><header className="remote-scene__heading"><h2>远端现场</h2><button type="button" className="remote-icon-button" aria-label={expanded ? "退出展开" : "展开执行现场"} title={expanded ? "退出展开 · Esc" : "展开执行现场"} onClick={() => setExpanded(!expanded)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={expanded ? "M8 3v5H3m18 0h-5V3M3 16h5v5m8 0v-5h5" : "M3 8V3h5m8 0h5v5M3 16v5h5m8 0h5v-5"} /></svg></button></header><nav className="remote-scene__tabs" role="tablist" aria-label="执行现场视图">{tabs.map(id => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{tabLabels[id][0]}<span> · {tabLabels[id][1]}</span></button>)}</nav>
    <div className="remote-scene__content">
      {disabled ? <div className="remote-scene-empty"><span>◈</span><p>{taskId ? "连接远端服务后查看执行现场" : "选择或新建任务，观察远端执行现场"}</p></div> : <>
        {/* Preserve a controlled framebuffer while viewing files/terminal. */}
        {(tab === "desktop" || snapshot?.humanControl) && engine === "openclaw" && <div className={`remote-scene-view${tab !== "desktop" ? " is-hidden" : ""}`}><RemoteDesktop engine={engine} taskId={taskId} humanControl={snapshot?.humanControl ?? false} /></div>}
        {tab === "browser" && (engine === "openhands" ? <RemoteDesktop engine={engine} taskId={taskId} humanControl={false} /> : <RemoteBrowser taskId={taskId} running={snapshot?.task.status === "running"} />)}
        {tab === "terminal" && <RemoteTerminalPanel engine={engine} taskId={taskId} snapshot={snapshot} />}
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
function RemoteDesktop({ engine, taskId, humanControl }: { engine: RemoteAgentId; taskId: string; humanControl: boolean }): JSX.Element {
  const bridge = window.selfmeLab!; const host = useRef<HTMLDivElement>(null); const framebuffer = useRef<RFB | undefined>(undefined);
  const [grant, setGrant] = useState<RemoteDesktopGrant>(); const [state, setState] = useState<"loading" | "connected" | "error">("loading"); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState(false); const [returning, setReturning] = useState(false); const [followUp, setFollowUp] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; void bridge.observeRemoteDesktop(engine, taskId, false).then(value => { if (alive.current) setGrant(value); }).catch(error => { if (alive.current) { setState("error"); setError(remoteError(error)); } }); return () => { alive.current = false; framebuffer.current?.disconnect(); }; }, [engine, taskId]);
  useEffect(() => { if (!humanControl && framebuffer.current) framebuffer.current.viewOnly = true; }, [humanControl]);
  useEffect(() => {
    if (!grant || !host.current) return;
    setState("loading"); setError("");
    let cancelled = false; let rfb: RFB | undefined;
    const connected = () => setState("connected"), disconnected = () => { setState("error"); setError("观察连接已断开，可以重新连接；任务仍在远端。" ); };
    const security = (event: Event) => { setState("error"); setError((event as CustomEvent).detail?.reason || "远端画面认证失败"); };
    void import("@novnc/novnc").then(({ default: Framebuffer }) => {
      if (cancelled || !host.current) return;
      rfb = new Framebuffer(host.current, grant.url, { credentials: { password: grant.password }, shared: true }); framebuffer.current = rfb;
      rfb.viewOnly = !grant.control; rfb.scaleViewport = true; rfb.resizeSession = false; rfb.qualityLevel = 9; rfb.compressionLevel = 2; rfb.background = "#05090d";
      rfb.addEventListener("connect", connected); rfb.addEventListener("disconnect", disconnected); rfb.addEventListener("securityfailure", security);
    }).catch(error => { if (!cancelled) { setState("error"); setError(remoteError(error)); } });
    return () => { cancelled = true; if (rfb) { rfb.removeEventListener("connect", connected); rfb.removeEventListener("disconnect", disconnected); rfb.removeEventListener("securityfailure", security); rfb.disconnect(); if (framebuffer.current === rfb) framebuffer.current = undefined; } };
  }, [grant]);
  async function observe(control: boolean): Promise<void> { if (busy) return; setBusy(true); setError(""); framebuffer.current?.disconnect(); try { const next = await bridge.observeRemoteDesktop(engine, taskId, control); if (alive.current) { setGrant(next); setConfirm(false); } } catch (error) { if (alive.current) { setError(remoteError(error)); setState("error"); } } finally { if (alive.current) setBusy(false); } }
  async function handBack(continueWork: boolean): Promise<void> { if (busy) return; setBusy(true); framebuffer.current?.disconnect(); try { const next = await bridge.returnRemoteDesktop(engine, taskId, continueWork ? followUp.trim() || "继续当前任务。" : undefined); if (alive.current) { setGrant(next); setReturning(false); setFollowUp(""); } } catch (error) { if (alive.current) { setError(remoteError(error)); setState("error"); } } finally { if (alive.current) setBusy(false); } }
  const controlled = humanControl;
  return <div className="remote-desktop"><div className="remote-observer-bar"><span className={`remote-observer-status is-${state}`}>{state === "loading" || busy ? <i className="remote-spinner" /> : <i />}{busy ? "正在准备远端现场" : state === "connected" ? controlled ? "CONTROL · 人工接管中" : "LIVE · 只读观察" : "连接已断开"}</span>{engine === "openclaw" && <button type="button" className={`remote-button${controlled ? " remote-button--danger" : ""}`} disabled={busy || state !== "connected"} onClick={() => controlled ? setReturning(true) : setConfirm(true)}>{controlled ? "交还智能体" : "接管"}</button>}<button type="button" className="remote-icon-button" aria-label="重新连接远端画面" title="重新连接" disabled={busy} onClick={() => void observe(Boolean(controlled))}>↻</button></div><div className="remote-rfb-stage"><div ref={host} className="remote-rfb" />{(state !== "connected" || busy) && <div className="remote-rfb-overlay">{state === "loading" || busy ? <><span className="remote-spinner" /><p>{busy ? "正在停止智能体操作并准备连接…" : "正在连接远端画面…"}</p></> : <><p>{error}</p><button type="button" className="remote-button" onClick={() => void observe(Boolean(controlled))} disabled={busy}>重新连接</button></>}</div>}</div>{error && state === "connected" && <p className="remote-error">{error}</p>}<small className="remote-scene-note">{engine === "openhands" ? "引擎共享浏览器画面 · 只读观察 · 自动适应窗口" : controlled ? "智能体工具操作已阻止 · 鼠标与键盘控制远端容器，不操作你的电脑" : "引擎共享桌面 · 只读观察 · 点击接管后才允许鼠标和键盘输入"}</small>
    {grant?.warning && <p className="remote-error" role="alert">{grant.warning}</p>}
    {confirm && <div className="remote-inline-confirm" role="dialog" aria-label="确认接管远端桌面"><h3>接管远端桌面</h3><p>将停止此引擎正在执行的任务，并阻止新的工具操作。确认停稳后，鼠标和键盘才会交给你。</p><div><button type="button" className="remote-button" disabled={busy} onClick={() => setConfirm(false)}>取消</button><button type="button" className="remote-button remote-button--primary" disabled={busy} onClick={() => void observe(true)}>{busy ? "正在停止…" : "停止并接管"}</button></div></div>}
    {returning && <div className="remote-inline-confirm" role="dialog" aria-label="交还远端桌面"><h3>交还智能体</h3><p>重新同步现场后，可以等待新指令，或明确让智能体继续。</p><textarea rows={3} aria-label="交还后的补充要求" placeholder="刚才做了什么，接下来希望怎么继续（可选）" value={followUp} onChange={event => setFollowUp(event.target.value)} /><div><button type="button" className="remote-button" disabled={busy} onClick={() => setReturning(false)}>取消</button><button type="button" className="remote-button" disabled={busy} onClick={() => void handBack(false)}>交还，等待指令</button><button type="button" className="remote-button remote-button--primary" disabled={busy} onClick={() => void handBack(true)}>交还并继续</button></div></div>}
  </div>;
}
function RemoteBrowser({ taskId, running }: { taskId: string; running?: boolean }): JSX.Element {
  const bridge = window.selfmeLab!, socket = useRef<WebSocket | undefined>(undefined); const alive = useRef(true), latest = useRef("");
  const [image, setImage] = useState(""); const [url, setUrl] = useState(""); const [status, setStatus] = useState("正在查找任务页面…"); const [connected, setConnected] = useState(false); const [busy, setBusy] = useState(false);
  async function connect(): Promise<void> {
    if (busy) return; setBusy(true); setConnected(false); socket.current?.close();
    try {
      const grant = await bridge.observeRemoteBrowser("openclaw", taskId); if (!alive.current) return;
      setUrl(grant.pageUrl); setStatus("正在连接浏览器画面…"); const ws = new WebSocket(grant.url); socket.current = ws; ws.binaryType = "arraybuffer";
      ws.onmessage = event => {
        if (!alive.current || socket.current !== ws) return;
        try {
          if (typeof event.data === "string") { const packet = JSON.parse(event.data); if (packet.type === "ready" || packet.type === "meta") { setConnected(true); setUrl(packet.url ?? grant.pageUrl); setStatus("LIVE · 只读观察"); } return; }
          const bytes = new Uint8Array(event.data as ArrayBuffer); if (bytes.length < 4) return;
          const length = new DataView(bytes.buffer).getUint32(0); if (length > 32_000 || length + 4 >= bytes.length) return;
          const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))); setUrl(meta.url ?? grant.pageUrl);
          const src = URL.createObjectURL(new Blob([bytes.subarray(4 + length)], { type: "image/jpeg" })); if (latest.current) URL.revokeObjectURL(latest.current); latest.current = src; setImage(src); setConnected(true); setStatus("LIVE · 只读观察");
        } catch { setStatus("画面格式异常，请重新连接"); }
      };
      ws.onclose = () => { if (alive.current && socket.current === ws) { setConnected(false); setStatus("观察已断开，点击刷新重新连接"); } };
      ws.onerror = () => { if (alive.current && socket.current === ws) setStatus("浏览器画面连接失败，请重新连接"); };
    } catch (error) { if (alive.current) setStatus(remoteError(error)); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void connect(); return () => { alive.current = false; socket.current?.close(); if (latest.current) URL.revokeObjectURL(latest.current); }; }, [taskId]);
  useEffect(() => { if (!running || connected || busy) return; const retry = setTimeout(() => void connect(), 2500); return () => clearTimeout(retry); }, [taskId, running, connected, busy, status]);
  return <div className="remote-browser"><div className="remote-observer-bar"><span className={`remote-observer-status is-${connected ? "connected" : "loading"}`}>{busy ? <i className="remote-spinner" /> : <i />}{connected ? "LIVE · 只读观察" : "Browser · 等待页面"}</span><button type="button" className="remote-icon-button" aria-label="刷新浏览器观察" title="重新查找此任务的浏览器页面" disabled={busy} onClick={() => void connect()}>↻</button></div>{url && <div className="remote-browser-url" title={url}>{url}</div>}<div className="remote-browser-screen">{image && <img src={image} alt="远端浏览器实时画面" />}{!connected && <div className="remote-rfb-overlay"><p>{status}</p>{!busy && <button type="button" className="remote-button" onClick={() => void connect()}>查看任务页面</button>}</div>}</div><small className="remote-scene-note">展示此任务所属的浏览器页面，不打开你本机的浏览器</small></div>;
}
function RemoteFiles({ engine, taskId, running, onPreview }: { engine: RemoteAgentId; taskId: string; running?: boolean; onPreview(path: string): void }): JSX.Element {
  const [directory, setDirectory] = useState(""); const [page, setPage] = useState<RemoteFilePage>(); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const generation = useRef(0);
  async function refresh(showBusy = true): Promise<void> { const version = ++generation.current; if (showBusy) setBusy(true); try { const result = await window.selfmeLab!.listRemoteTaskFiles(engine, taskId, directory); if (version === generation.current) { setPage(result); setError(""); } } catch (error) { if (version === generation.current) setError(remoteError(error)); } finally { if (version === generation.current) setBusy(false); } }
  useEffect(() => { void refresh(); const timer = running ? setInterval(() => void refresh(false), 3000) : undefined; return () => { ++generation.current; clearInterval(timer); }; }, [engine, taskId, directory, running]);
  return <div className="remote-files"><header><button type="button" className="remote-icon-button" disabled={!directory} aria-label="返回上层远端目录" title="上层目录" onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}>↑</button><span title={directory}>/{directory || "任务文件"}</span><button type="button" className="remote-icon-button" aria-label="刷新远端文件" title="刷新文件" onClick={() => void refresh()} disabled={busy}>↻</button></header>{error && <p className="remote-error">{error}</p>}<div className="remote-files__list">{busy && !page ? <div className="remote-scene-empty"><span className="remote-spinner" /></div> : page?.files.length ? [...page.files].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).map(file => <div key={file.path} className="remote-file-row"><button type="button" className="remote-file-name" title={file.name} onClick={() => file.directory ? setDirectory(file.path) : onPreview(file.path)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={file.directory ? "M2 6h8l2 2h10v12H2z" : "M5 2h9l5 5v15H5zM14 2v6h5M8 12h8m-8 4h8"} /></svg><span>{file.name}<small>{file.directory ? "目录" : remoteFileSize(file.size)}</small></span></button>{!file.directory && <button type="button" className="remote-icon-button" aria-label={`下载：${file.name}`} title="下载文件" onClick={() => void window.selfmeLab!.downloadRemoteTaskFile(engine, taskId, file.path).catch(error => setError(remoteError(error)))}>↓</button>}</div>) : <div className="remote-scene-empty"><span>▤</span><p>任务还没有生成文件</p></div>}</div>{page?.truncated && <small className="remote-scene-note">此目录仅显示前 500 项，请进入子目录查看</small>}</div>;
}
function RemoteTerminalPanel({ engine, taskId, snapshot }: { engine: RemoteAgentId; taskId: string; snapshot?: RemoteTaskSnapshot }): JSX.Element {
  const [administration, setAdministration] = useState(false);
  const tools = snapshot?.items.filter(item => item.tool && /terminal|exec|bash|shell/.test(item.tool.name)) ?? [];
  return <div className="remote-terminal-panel">{engine === "openclaw" && <div className="remote-terminal-tabs"><button type="button" aria-pressed={!administration} onClick={() => setAdministration(false)}>智能体输出</button><button type="button" aria-pressed={administration} onClick={() => setAdministration(true)}>管理终端</button></div>}{administration ? <AdminTerminal taskId={taskId} /> : <div className="remote-agent-console">{tools.length ? tools.map(item => <div key={item.id}><header><span className={item.tool!.status === "running" ? "remote-spinner" : ""}>{item.tool!.status === "completed" ? "✓" : ""}</span>{item.tool!.title}</header><pre className="remote-command">$ {item.tool!.input}</pre>{item.tool!.output && <pre>{item.tool!.output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")}</pre>}</div>) : <div className="remote-scene-empty"><span>›_</span><p>智能体执行命令后，输出会显示在这里</p></div>}</div>}</div>;
}
function AdminTerminal({ taskId }: { taskId: string }): JSX.Element {
  const bridge = window.selfmeLab!; const host = useRef<HTMLDivElement>(null); const terminal = useRef<Terminal | undefined>(undefined); const current = useRef<RemoteTerminal | undefined>(undefined); const alive = useRef(true);
  const [info, setInfo] = useState<RemoteTerminal>(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [ended, setEnded] = useState(false);
  useEffect(() => { alive.current = true; const term = new Terminal({ fontSize: 12, fontFamily: "Menlo, monospace", cursorBlink: true, scrollback: 5000, theme: { background: "#060b0f", foreground: "#c4d1d9", cursor: "#f28b7b", selectionBackground: "#f28b7b35" } }); const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current!); terminal.current = term;
    const size = () => { if (!host.current?.clientHeight) return; fit.fit(); if (current.current) void bridge.resizeRemoteTerminal("openclaw", taskId, current.current.id, term.cols, term.rows).catch(error => { if (alive.current) setError(remoteError(error)); }); };
    const observer = new ResizeObserver(size); observer.observe(host.current!); requestAnimationFrame(size);
    const input = term.onData(data => { if (current.current && !ended) void bridge.inputRemoteTerminal("openclaw", taskId, current.current.id, data).catch(error => { if (alive.current) setError(remoteError(error)); }); });
    const unsubscribe = bridge.onRemoteTerminalEvent(event => { if (event.taskId !== taskId || event.terminalId !== current.current?.id) return; if (event.data) term.write(event.data); if (event.exited) { current.current = undefined; setEnded(true); term.writeln("\r\n[远端终端已结束]"); if (event.detail) setError(event.detail); } });
    return () => { alive.current = false; observer.disconnect(); input.dispose(); unsubscribe(); if (current.current) void bridge.closeRemoteTerminal("openclaw", taskId, current.current.id).catch(() => {}); current.current = undefined; terminal.current = undefined; term.dispose(); };
  }, [taskId]);
  async function open(): Promise<void> { if (busy) return; setBusy(true); setError(""); try { const result = await bridge.openRemoteTerminal("openclaw", taskId); if (!alive.current) { await bridge.closeRemoteTerminal("openclaw", taskId, result.id); return; } current.current = result; setInfo(result); setEnded(false); terminal.current?.reset(); if (result.buffer) terminal.current?.write(result.buffer); terminal.current?.focus(); } catch (error) { if (alive.current) setError(remoteError(error)); } finally { if (alive.current) setBusy(false); } }
  async function close(): Promise<void> { if (!current.current || busy) return; setBusy(true); try { await bridge.closeRemoteTerminal("openclaw", taskId, current.current.id); current.current = undefined; setEnded(true); } catch (error) { setError(remoteError(error)); } finally { setBusy(false); } }
  return <div className="remote-admin-terminal"><div className="remote-terminal-bar"><span title={info?.cwd}>{info && !ended ? info.cwd : "远端容器终端"}</span><button type="button" className="remote-button" disabled={busy} onClick={() => void (info && !ended ? close() : open())}>{busy ? "连接中…" : info && !ended ? "关闭终端" : "打开终端"}</button></div><small className="remote-scene-note">手动执行的命令不经过智能体审批，不会自动加入对话；此终端不在你的电脑上。</small>{error && <p className="remote-error">{error}</p>}<div ref={host} className="remote-xterm" />{!info && <div className="remote-terminal-intro"><p>仅在需要调试远端环境时开启</p></div>}</div>;
}
