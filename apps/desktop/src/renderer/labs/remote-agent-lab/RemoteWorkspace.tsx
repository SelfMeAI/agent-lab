import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import type { RemoteAgentId, RemoteTask, RemoteTaskSnapshot, RemoteUploadedFile } from "../../../../../../packages/contracts/src/remote-agent";
import { RemoteMark, remoteEngines } from "./RemoteAgentPage";
import { RemoteFailureCard, RemoteTranscriptItem, type RemoteRecoveryActions } from "./RemoteTranscript";
import { RemoteScene } from "./RemoteScene";
import { RemoteExecutionControl, RemoteExecutionStatus } from "./RemoteExecutionControls";
import { RemotePendingInputs } from "./RemotePendingInputs";
import { remoteError } from "./service-presentation";
import { calendarDayKey, dateDividerLabel, exactTime, sessionTimeLabel } from "../agent-lab/conversation-time";
import { observeTranscriptLayout } from "../agent-lab/transcript-layout";
import { activeRemoteFailure, remoteComposerHint, remoteTaskLabels } from "./task-presentation";
import { mergeRemoteTaskCatalog, upsertRemoteTask } from "../../../../../../packages/remote-agent/src/task-order";
import "./workspace.css";

const selectedTasks = new Map<RemoteAgentId, string>();
const drafts = new Map<string, string>();
const attachments = new Map<string, RemoteUploadedFile[]>();
const inputTickets = new Map<string, { signature: string; id: string }>();
export function RemoteWorkspace({ engine, available, revision }: { engine: RemoteAgentId; available: boolean; revision: number }): JSX.Element {
  const bridge = window.agentLab!;
  const [tasks, setTasks] = useState<RemoteTask[]>([]); const [snapshot, setSnapshot] = useState<RemoteTaskSnapshot>();
  const [selected, setSelected] = useState(""); const [opening, setOpening] = useState(false); const [submitting, setSubmitting] = useState(false); const [acting, setActing] = useState(false);
  const [prompt, setPrompt] = useState(""); const [files, setFiles] = useState<RemoteUploadedFile[]>([]); const [error, setError] = useState(""); const [atBottom, setAtBottom] = useState(true);
  const active = useRef(""); const alive = useRef(true); const output = useRef<HTMLDivElement>(null); const input = useRef<HTMLTextAreaElement>(null); const follow = useRef(true); const version = useRef(0);
  const submissionLock = useRef(false);
  const catalogVersion = useRef(0);
  const busy = snapshot?.task.status === "running" || snapshot?.task.status === "waiting";
  const inputMode = snapshot?.queue?.mode ?? "queue";
  const queuedSend = inputMode === "queue" && (busy || !!snapshot?.queue?.items.length);
  const failure = activeRemoteFailure(snapshot);
  const connectionLost = snapshot && snapshot.connection !== "connected";
  const composerHint = remoteComposerHint(snapshot);
  const recovery: RemoteRecoveryActions = {
    disabled: !available || opening || acting || submitting || !!connectionLost,
    continueDisabled: !!prompt.trim() || !!files.length,
    onContinue: () => void send(true), onCompose: () => input.current?.focus(),
  };
  const slot = (id: string) => engine + ":" + id;
  const updateTask = (task: RemoteTask): void => setTasks(previous => upsertRemoteTask(previous, task));
  async function select(id: string): Promise<void> {
    const ticket = ++version.current; const previous = active.current; active.current = id; setSelected(id); selectedTasks.set(engine, id); setOpening(true); setSnapshot(undefined); setError("");
    setPrompt(drafts.get(slot(id)) ?? ""); setFiles(attachments.get(slot(id)) ?? []); follow.current = true;
    if (previous && previous !== id) await bridge.closeRemoteTask(engine, previous).catch(() => {});
    try { const next = await bridge.openRemoteTask(engine, id); if (alive.current && ticket === version.current) { setSnapshot(next); updateTask(next.task); } }
    catch (cause) { if (alive.current && ticket === version.current) setError(remoteError(cause)); }
    finally { if (alive.current && ticket === version.current) setOpening(false); }
  }
  async function refresh(): Promise<void> {
    const ticket = ++catalogVersion.current;
    const rows = await bridge.listRemoteTasks(engine); if (!alive.current || ticket !== catalogVersion.current) return;
    setTasks(previous => mergeRemoteTaskCatalog(previous, rows));
    if (!active.current) { const id = selectedTasks.get(engine); const task = rows.find(task => task.id === id) ?? rows[0]; if (task) await select(task.id); }
  }
  useEffect(() => {
    alive.current = true; let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = bridge.onRemoteTaskUpdate(event => { if (event.engine !== engine || !alive.current) return; updateTask(event.snapshot.task); if (event.taskId === active.current) setSnapshot(event.snapshot); });
    async function poll(): Promise<void> { if (available) try { await refresh(); } catch (cause) { if (alive.current) setError(remoteError(cause)); } if (alive.current) timer = setTimeout(() => void poll(), 6000); }
    active.current = ""; setSelected(""); setSnapshot(undefined); void poll();
    return () => { alive.current = false; ++version.current; ++catalogVersion.current; clearTimeout(timer); unsubscribe(); if (active.current) void bridge.closeRemoteTask(engine, active.current).catch(() => {}); active.current = ""; };
  }, [engine, available, revision]);
  useEffect(() => {
    if (!selected || opening || !available) return;
    let closed = false, timer: ReturnType<typeof setTimeout>;
    const id = selected;
    async function pollInputs(): Promise<void> {
      try { await bridge.getRemoteInputQueue(engine, id); }
      catch (cause) { if (!closed && active.current === id) setError(remoteError(cause)); }
      if (!closed) timer = setTimeout(() => void pollInputs(), 2000);
    }
    void pollInputs();
    return () => { closed = true; clearTimeout(timer); };
  }, [engine, selected, opening, available]);
  useLayoutEffect(() => { if (output.current) return observeTranscriptLayout(output.current, follow, setAtBottom); }, [selected, opening]);
  useLayoutEffect(() => { const area = input.current; if (!area) return; area.style.height = "0px"; area.style.height = Math.min(132, Math.max(42, area.scrollHeight)) + "px"; area.style.overflowY = area.scrollHeight > 132 ? "auto" : "hidden"; }, [prompt, selected]);
  useLayoutEffect(() => { if (output.current && follow.current) output.current.scrollTop = output.current.scrollHeight; }, [snapshot?.items]);
  async function run(action: () => Promise<unknown>): Promise<void> { if (acting) return; setActing(true); setError(""); try { await action(); } catch (cause) { setError(remoteError(cause)); } finally { if (alive.current) setActing(false); } }
  async function create(): Promise<void> {
    // Disable the old composer immediately; a new native task can take a moment to create.
    await run(async () => { setOpening(true); try { const task = await bridge.createRemoteTask(engine); ++catalogVersion.current; updateTask(task); await select(task.id); } finally { if (alive.current) setOpening(false); } });
  }
  async function send(continuing = false): Promise<void> {
    if (submissionLock.current || acting || opening || !available || !snapshot || !selected) return;
    if (continuing ? snapshot.task.status !== "error" || snapshot.connection !== "connected" || !!prompt.trim() || !!files.length : !prompt.trim() && !files.length) return;
    const id = selected, value = continuing ? "" : prompt, uploaded = continuing ? [] : files;
    submissionLock.current = true; setSubmitting(true); setError(""); follow.current = true;
    try {
      if (continuing) await bridge.controlRemoteTask(engine, id, "resume");
      else {
        const signature = JSON.stringify([value, uploaded.map(file => file.path)]);
        const prior = inputTickets.get(slot(id));
        const ticket = prior?.signature === signature ? prior : { signature, id: crypto.randomUUID() };
        inputTickets.set(slot(id), ticket);
        await bridge.sendRemoteTaskMessage(engine, id, value, uploaded, { mode: inputMode, requestId: ticket.id });
        if (inputTickets.get(slot(id)) === ticket) inputTickets.delete(slot(id));
      }
      // A slow submission must not erase text or files added while it was in flight.
      const unchanged = !continuing && (drafts.get(slot(id)) ?? "") === value;
      if (unchanged) drafts.delete(slot(id));
      const sent = new Set(uploaded.map(file => file.path));
      const remaining = (attachments.get(slot(id)) ?? []).filter(file => !sent.has(file.path));
      if (remaining.length) attachments.set(slot(id), remaining); else attachments.delete(slot(id));
      if (active.current === id) { if (unchanged) setPrompt(""); setFiles(remaining); input.current?.focus(); }
    }
    catch (cause) { if (active.current === id) setError(remoteError(cause)); }
    finally { submissionLock.current = false; if (alive.current) setSubmitting(false); }
  }
  async function remove(id: string): Promise<void> { await run(async () => { ++catalogVersion.current; await bridge.deleteRemoteTask(engine, id); const rows = await bridge.listRemoteTasks(engine); ++catalogVersion.current; setTasks(previous => mergeRemoteTaskCatalog(previous, rows)); if (rows.some(task => task.id === id)) return; drafts.delete(slot(id)); attachments.delete(slot(id)); inputTickets.delete(slot(id)); if (active.current === id) { active.current = ""; setSelected(""); setSnapshot(undefined); selectedTasks.delete(engine); if (rows[0]) await select(rows[0].id); } }); }
  function draft(value: string): void { setPrompt(value); drafts.set(slot(selected), value); }
  let lastDay: string | null = null;
  return <div className="remote-workspace" style={{ "--remote-accent": remoteEngines[engine].color } as CSSProperties}>
    <aside className="remote-task-rail">
      <header><h2>任务</h2><button type="button" className="remote-icon-button" aria-label="新建远端任务" title="新建任务" disabled={!available || acting || opening} onClick={() => void create()}>+</button></header>
      <div className="remote-task-list">{tasks.map(task => <div key={task.id} className={`remote-task-row${selected === task.id ? " is-selected" : ""}`}><button type="button" className="remote-task-select" disabled={opening} onClick={() => void select(task.id)}><i className={`remote-task-dot is-${task.status}`} /><span><strong>{task.title}</strong><small>{remoteTaskLabels[task.status]}<time dateTime={task.updatedAt} title={exactTime(task.updatedAt) ?? undefined}>{sessionTimeLabel(task.updatedAt)}</time></small></span></button><button type="button" className="remote-task-delete" aria-label={`删除任务：${task.title}`} title="删除任务" disabled={acting || opening} onClick={() => void remove(task.id)}>×</button></div>)}{!tasks.length && <p className="remote-empty-note">新建任务，开始远端工作</p>}</div>
    </aside>
    <section className="remote-conversation"><header className="remote-conversation__heading"><h2 title={snapshot?.task.title}>{snapshot?.task.title ?? "远端任务"}</h2></header>
      <div ref={output} className="remote-transcript" onScroll={() => { const node = output.current!; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72; setAtBottom(follow.current); }}>
        {!snapshot ? <div className="remote-chat-empty"><RemoteMark engine={engine} /><h3>{opening ? "正在读取远端任务" : "在远端开始一件事"}</h3><p>{opening ? "同步服务端历史与实时连接…" : "上传资料、描述目标，观察智能体的执行过程与产物"}</p>{!opening && <button className="remote-button" type="button" disabled={!available || acting} onClick={() => void create()}>新建任务</button>}</div> : <>{snapshot.hasEarlier && <button type="button" className="remote-history-button" disabled={acting} onClick={() => void run(async () => { follow.current = false; const previous = output.current!.scrollHeight; const next = await bridge.loadEarlierRemoteTask(engine, selected); setSnapshot(next); requestAnimationFrame(() => { if (output.current) output.current.scrollTop += output.current.scrollHeight - previous; }); })}>加载更早记录</button>}{snapshot.items.map(item => { const day = item.at ? calendarDayKey(item.at) : null; const divider = day && day !== lastDay; if (day) lastDay = day; return <Fragment key={item.id}>{divider && <div className="remote-date-divider">{dateDividerLabel(item.at!)}</div>}<RemoteTranscriptItem item={item} engine={engine} busy={acting} recovery={item.id === failure?.itemId ? recovery : undefined} onApproval={(id, decision) => void run(() => bridge.respondRemoteApproval(engine, selected, id, decision))} onAnswer={(id, answers) => void run(() => bridge.respondRemoteQuestion(engine, selected, id, answers))} /></Fragment>; })}{failure && !failure.itemId && <RemoteFailureCard failure={failure.failure} recovery={recovery} />}{!snapshot.items.length && !failure && <p className="remote-empty-note">任务已准备好，发送消息即可开始</p>}</>}
      </div>
      {!atBottom && <div className="remote-jump-anchor"><button type="button" className="remote-jump-latest" onClick={() => { follow.current = true; if (output.current) output.current.scrollTop = output.current.scrollHeight; setAtBottom(true); }}>回到最新 ↓</button></div>}
      {(error || snapshot?.error || connectionLost) && <div className="remote-conversation__error" role="alert">{error || snapshot?.error || "连接暂时中断，正在重新同步远端状态。"}{selected && (!snapshot || connectionLost) && <button type="button" onClick={() => void select(selected)} disabled={opening || acting || submitting}>重新连接</button>}</div>}
      <form className="remote-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        <div className="remote-composer__status-row"><RemoteExecutionStatus status={snapshot?.task.status} opening={opening} />
          {snapshot && <select className="remote-input-mode" aria-label="工作中发送方式" title={snapshot.queue?.items.length ? "先处理待发消息，再切换默认发送方式" : "只决定工作中发送的消息如何处理"} value={inputMode} disabled={opening || acting || submitting || !available || !snapshot.queue || !!snapshot.queue.items.length} onChange={event => void run(() => bridge.setRemoteInputMode(engine, selected, event.target.value as "queue" | "steer"))}><option value="queue">Queue · 排队发送</option><option value="steer">Steer · 补充本轮</option></select>}
        </div>
        {snapshot?.queue && <RemotePendingInputs queue={snapshot.queue} running={busy} disabled={acting || opening || submitting || !available || !!connectionLost} onRemove={id => void run(() => bridge.removeRemoteQueuedMessage(engine, selected, id))} onSteer={id => void run(() => bridge.steerRemoteQueuedMessage(engine, selected, id))} />}
        {!!files.length && <div className="remote-attachments">{files.map(file => <span key={file.path} title={file.name}>▤ {file.name}<button type="button" title="不附加到消息（已上传文件保留在远端）" aria-label={`移除附件：${file.name}`} onClick={() => { const remaining = files.filter(row => row.path !== file.path); setFiles(remaining); attachments.set(slot(selected), remaining); }}>×</button></span>)}</div>}
        <div className="remote-composer__row">
          <button type="button" className="remote-icon-button" aria-label="上传文件" title={files.length >= 10 ? "每条消息最多附加 10 个文件" : "上传文件 · 单个最多 20 MB"} disabled={!snapshot || opening || acting || !available || files.length >= 10} onClick={() => void run(async () => { const id = selected; const added = await bridge.uploadRemoteTaskFiles(engine, id, 10 - files.length); const all = [...(attachments.get(slot(id)) ?? []), ...added]; attachments.set(slot(id), all); if (active.current === id) setFiles(all); })}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M8 12v5a4 4 0 0 0 8 0V7a3 3 0 0 0-6 0v10a1 1 0 0 0 2 0V8" /></svg>
          </button>
          <textarea ref={input} value={prompt} placeholder={queuedSend ? "添加待发消息…" : busy ? "补充当前工作…" : failure ? "发送新要求，继续这个任务…" : "发送消息，或描述你想完成的事…"} aria-label="远端任务消息" rows={1} disabled={!snapshot || opening || !available} onChange={event => draft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
          <RemoteExecutionControl status={snapshot?.task.status} queuePaused={!!snapshot?.queue?.paused} disabled={acting || opening || submitting || !available || !!connectionLost} onControl={action => void run(() => bridge.controlRemoteTask(engine, selected, action))} />
          <button className="remote-send" type="submit" aria-label={queuedSend ? "Queue · 排队发送" : busy ? "Steer · 补充本轮" : "发送消息"} title={queuedSend ? "添加到待发区 · Enter 发送 · Shift+Enter 换行" : busy ? "补充当前轮 · Enter 发送 · Shift+Enter 换行" : "Enter 发送 · Shift+Enter 换行"} disabled={!snapshot || opening || acting || submitting || !available || (!prompt.trim() && !files.length)}>{submitting ? <span className="remote-spinner" /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="m3 10 18-7-7 18-3-8-8-3Z" /><path d="m11 13 10-10" /></svg>}</button>
        </div>
        {composerHint && <small className={`remote-composer__hint${failure && !connectionLost ? " is-interrupted" : ""}`}>{composerHint}</small>}
      </form>
    </section>
    <RemoteScene key={selected || "empty"} engine={engine} taskId={selected} snapshot={snapshot} available={available && !opening} />
  </div>;
}
