import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentSessionSummary, ProviderStatus, RuntimePhase } from "../../../../../../packages/contracts/src/index";
import { LabIcon } from "../../shell/LabIcon";
import { agentStores, type AgentRuntimeId, type TranscriptEntry } from "./agent-store";
import { calendarDayKey, clockTime, dateDividerLabel, durationMsBetween, elapsedTime, exactTime, sessionTimeLabel, toolDuration, turnDuration } from "./conversation-time";
import { presentEntry, visibleTranscriptEntries } from "./tool-presentation";

const names = { dsh: "DSH", codex: "CODEX", pi: "PI", "kimi-code": "KIMI CODE" } as const;
const busyPhases = new Set<RuntimePhase>(["starting", "running", "approval", "cancelling"]);

function sessionStateLabel(phase: RuntimePhase): string {
  if (phase === "running") return "工作中";
  if (phase === "approval") return "待审批";
  if (phase === "starting") return "连接中";
  if (phase === "cancelling") return "取消中";
  if (phase === "ready") return "待命";
  if (phase === "error") return "出错";
  return "已暂停";
}

const approvalOptionLabels: Record<string, string> = {
  approve: "同意",
  "approve once": "允许一次",
  "allow once": "允许一次",
  "approve for this session": "本会话允许同类操作",
  "allow for this session": "本会话允许同类操作",
  "always allow": "始终允许",
  "allow always": "始终允许",
  "reject once": "仅拒绝本次",
  "deny once": "仅拒绝本次",
  "reject always": "始终拒绝",
  "deny always": "始终拒绝",
  revise: "修改计划",
  "reject and exit": "拒绝并退出",
  reject: "拒绝",
  deny: "拒绝",
};

const kimiApprovalTitles: Record<string, string> = {
  Bash: "请求执行命令",
  Write: "请求写入文件",
  Edit: "请求修改文件",
  ExitPlanMode: "请求确认计划",
};

function approvalOptionLabel(name: string): string {
  return approvalOptionLabels[name.trim().toLowerCase()] ?? name;
}

function approvalActionLabel(runtimeId: AgentRuntimeId, title: string): string {
  return runtimeId === "kimi-code" ? kimiApprovalTitles[title.trim()] ?? title : title;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function AgentMarkdown({ text }: { text: string }): JSX.Element {
  return <div className="dsh-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <span className="dsh-markdown__link" title={href}>{children ?? href}</span>,
    img: ({ alt }) => <span className="dsh-markdown__image">[图片：{alt || "未提供描述"}]</span>,
  }}>{text}</ReactMarkdown></div>;
}

function RunElapsed({ startedAt }: { startedAt: string }): JSX.Element | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  const elapsed = elapsedTime(startedAt, now);
  return elapsed ? <small className="dsh-live-status__elapsed">已运行 {elapsed}</small> : null;
}

function useCalendarToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    const schedule = (): void => {
      const now = new Date();
      const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(() => {
        setToday(new Date());
        schedule();
      }, nextDay.getTime() - now.getTime() + 100);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);
  return today;
}

function ToolItem({ entry, workspace }: { entry: TranscriptEntry; workspace: string | null }): JSX.Element {
  const view = presentEntry(entry);
  const recordedAt = clockTime(entry.at, true);
  const exactRecordedAt = exactTime(entry.at);
  const exactFinishedAt = entry.finishedAt ? exactTime(entry.finishedAt) : null;
  const durationMs = view.durationMs ?? (entry.finishedAt ? durationMsBetween(entry.at, entry.finishedAt) : null);
  const duration = durationMs === undefined || durationMs === null ? null : toolDuration(durationMs);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const hadDiffRef = useRef(false);
  const hasDiff = view.files.some((file) => file.lines.length > 0);
  useEffect(() => {
    if (hasDiff && !hadDiffRef.current && detailsRef.current) detailsRef.current.open = true;
    hadDiffRef.current = hasDiff;
  }, [hasDiff]);
  return <details className="dsh-tool" id={`transcript-${entry.id}`} ref={detailsRef}>
    <summary>
      <span className={`dsh-tool__indicator ${view.status === "进行中" ? "is-active" : ""}`} aria-hidden="true" />
      <span className="dsh-tool__headline"><strong>{view.label}</strong>{view.summary && <small>{view.summary}</small>}</span>
      <span className="dsh-tool__status">{view.status}</span>
      <span className="dsh-tool__chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="dsh-tool__details">
      {view.command && <div className="dsh-tool__section"><span className="dsh-tool__caption">命令</span><code className="dsh-tool__command">{view.command}</code>{view.cwd && <small className="dsh-tool__meta">位于 {view.cwd}</small>}</div>}
      {view.plan.length > 0 && <div className="dsh-tool__section"><span className="dsh-tool__caption">步骤</span><ol className="dsh-tool__plan">{view.plan.map((step, index) => <li key={`${index}:${step.text}`} className={`is-${step.status}`}><span>{step.status === "completed" ? "✓" : step.status === "in_progress" || step.status === "inProgress" ? "◉" : "○"}</span>{step.text}</li>)}</ol></div>}
      {view.files.map((file) => <div className="dsh-tool__section dsh-tool__file" key={file.path}>
        <div className="dsh-tool__file-heading"><span className="dsh-tool__caption">{file.action.toUpperCase()}</span><strong title={file.path}>{workspace && file.path.startsWith(`${workspace}/`) ? file.path.slice(workspace.length + 1) : file.path}</strong><span className="dsh-tool__added">+{file.added}</span><span className="dsh-tool__removed">−{file.removed}</span></div>
        {file.lines.length > 0 && <div className="dsh-tool__diff">{file.lines.map((line, index) => <div className={`dsh-tool__diff-line is-${line.kind}`} key={`${index}:${line.text}`}>{line.text || " "}</div>)}</div>}
        {file.hiddenLines > 0 && <small className="dsh-tool__meta">仅展示前 160 行，另有 {file.hiddenLines} 行变更</small>}
      </div>)}
      {view.locations.length > 0 && view.files.length === 0 && <div className="dsh-tool__section"><span className="dsh-tool__caption">涉及位置</span><div className="dsh-tool__paths">{view.locations.map((path) => <code key={path}>{path}</code>)}</div></div>}
      {view.output && <div className="dsh-tool__section"><span className="dsh-tool__caption">{entry.kind === "status" ? "详情" : "结果"}</span><pre className="dsh-tool__output">{view.output}</pre></div>}
      {view.notes.map((note, index) => <p className="dsh-tool__note" key={`${index}:${note.slice(0, 16)}`}>{note}</p>)}
      {(recordedAt || duration || view.exitCode !== undefined) && <div className="dsh-tool__timing">
        {recordedAt && <span>{entry.kind === "tool" ? "执行于" : "记录于"} <time dateTime={entry.at} title={exactFinishedAt ? `${exactRecordedAt} → ${exactFinishedAt}` : exactRecordedAt ?? undefined}>{recordedAt}</time></span>}
        {duration && <span>用时 {duration}</span>}
        {view.exitCode !== undefined && <span>退出码 {view.exitCode}</span>}
      </div>}
      {!view.command && !view.output && view.files.length === 0 && view.plan.length === 0 && view.locations.length === 0 && view.notes.length === 0 && <p className="dsh-tool__meta">运行时未提供更多细节</p>}
    </div>
  </details>;
}

function TranscriptItem({ entry, runtimeId, workspace, onApprove, approvalBusy }: {
  entry: TranscriptEntry;
  runtimeId: AgentRuntimeId;
  workspace: string | null;
  onApprove(requestId: string | number, optionId: string): void;
  approvalBusy: boolean;
}): JSX.Element {
  const time = clockTime(entry.at);
  const exact = exactTime(entry.at);
  if (entry.kind === "turn_end") {
    if (!entry.hasExecutionActivity) return <></>;
    const duration = entry.startedAt ? turnDuration(entry.startedAt, entry.at) : null;
    return duration ? <div className="dsh-turn-duration" title={`${exactTime(entry.startedAt!)} → ${exact}`}><span>本轮用时</span><strong>{duration}</strong></div> : <></>;
  }
  if (entry.kind === "user") return (
    <article className="dsh-entry dsh-entry--user">
      <div className="dsh-entry__avatar dsh-entry__avatar--user" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="3.1" />
          <path d="M5.4 19c.6-3.4 2.9-5.1 6.6-5.1s6 1.7 6.6 5.1" />
        </svg>
      </div>
      <div className="dsh-entry__body"><div className="dsh-entry__heading"><span className="dsh-entry__label">YOU</span>{time && <time dateTime={entry.at} title={exact ?? undefined}>{time}</time>}</div><p>{entry.text}</p>
        {entry.deliveryMode === "steer" && <span className={`dsh-steering-receipt dsh-steering-receipt--${entry.deliveryState ?? "submitting"}`} title={entry.deliveryDetail ?? "补充在 Harness 的安全节点接入当前任务；已接入不代表模型一定遵从"}>
          <i aria-hidden="true" />{{ submitting: "补充 · 正在提交", queued: "补充 · 等待接入", incorporated: "补充 · 已接入本轮", unconfirmed: "补充 · 未确认接入", rejected: "补充 · 未提交" }[entry.deliveryState ?? "submitting"]}
        </span>}
      </div>
    </article>
  );
  if (entry.kind === "approval" && entry.approval) return (
    <article className="dsh-approval">
      <span className="dsh-approval__mark" aria-hidden="true">!</span>
      <div className="dsh-approval__content">
        <div className="dsh-approval__heading"><strong>需要你确认</strong>{time && <time dateTime={entry.at} title={exact ?? undefined}>{time}</time>}</div>
        <p>{approvalActionLabel(runtimeId, entry.text || entry.approval.title)}</p>
        {entry.approval.toolCallId && <small>工具调用 · {entry.approval.toolCallId}</small>}
      </div>
      <div className="dsh-approval__actions">
        {entry.approval.options.map((option) => (
          <button
            className={option.kind.includes("allow") ? "is-allow" : "is-reject"}
            disabled={approvalBusy}
            key={option.optionId}
            onClick={() => onApprove(entry.approval!.requestId, option.optionId)}
            title={option.kind === "allow_session" ? "仅当前会话有效，新会话会重新询问" : undefined}
            type="button"
          >{approvalOptionLabel(option.name)}</button>
        ))}
      </div>
    </article>
  );
  if (entry.kind === "tool" || entry.kind === "status") return <ToolItem entry={entry} workspace={workspace} />;
  if (entry.kind === "error") return <div className="dsh-error" role="alert">{entry.text}</div>;
  return (
    <article className="dsh-entry dsh-entry--agent">
      <LabIcon className="dsh-entry__avatar" runtimeId={runtimeId} />
      <div className="dsh-entry__body"><div className="dsh-entry__heading"><span className="dsh-entry__label">{names[runtimeId]} · 回复</span>{time && <time dateTime={entry.at} title={exact ?? undefined}>{time}</time>}</div><AgentMarkdown text={entry.text} /></div>
    </article>
  );
}

export function AgentWorkspace({ runtimeId, onOpenSettings, providerRevision = 0 }: {
  runtimeId: AgentRuntimeId;
  onOpenSettings?(): void;
  providerRevision?: number;
}): JSX.Element {
  const store = agentStores[runtimeId];
  const today = useCalendarToday();
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [connectingSessionId, setConnectingSessionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [railError, setRailError] = useState<string | null>(null);
  const [showDeletedSessions, setShowDeletedSessions] = useState(false);
  const [sessionAction, setSessionAction] = useState<{ id: string; title: string; kind: "delete" | "purge" } | null>(null);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const session = snapshot.sessions.find((item) => item.id === snapshot.selectedSessionId) ?? null;
  const workspace = session?.workspace ?? null;
  const outputRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const followOutputRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  const connect = useCallback(async (sessionId: string): Promise<void> => {
    if (!window.selfmeLab) return;
    setConnectingSessionId(sessionId);
    setLocalError(null);
    try {
      await window.selfmeLab.startAgentSession(sessionId);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setConnectingSessionId((current) => current === sessionId ? null : current);
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (window.selfmeLab) {
      void Promise.all([window.selfmeLab.getProviderStatus(runtimeId), window.selfmeLab.getAgentSessionCatalog(runtimeId)])
        .then(async ([status, catalog]) => {
          if (!active) return;
          setProvider(status);
          store.setCatalog(catalog);
          if (catalog.selectedSessionId) {
            const history = await window.selfmeLab!.getAgentSessionEvents(catalog.selectedSessionId);
            if (!active) return;
            store.loadHistory(catalog.selectedSessionId, history);
            if (status.configured) await connect(catalog.selectedSessionId);
          }
        }).catch((error: unknown) => { if (active) setLocalError(errorMessage(error)); });
    }
    return () => { active = false; };
  }, [connect, providerRevision, runtimeId, store]);

  useLayoutEffect(() => {
    const output = outputRef.current;
    if (output && followOutputRef.current) output.scrollTop = output.scrollHeight;
  }, [snapshot.entries, snapshot.statusText, localError]);

  useLayoutEffect(() => {
    const input = promptRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 38), 178)}px`;
    input.style.overflowY = input.scrollHeight > 178 ? "auto" : "hidden";
  }, [prompt]);

  useEffect(() => {
    if (!sessionAction) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !sessionActionBusy) setSessionAction(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sessionAction, sessionActionBusy]);

  function trackOutputScroll(): void {
    const output = outputRef.current;
    if (!output) return;
    const nearLatest = output.scrollHeight - output.scrollTop - output.clientHeight < 72;
    followOutputRef.current = nearLatest;
    setShowLatest(!nearLatest);
  }

  function jumpToLatest(): void {
    const output = outputRef.current;
    if (!output) return;
    followOutputRef.current = true;
    setShowLatest(false);
    output.scrollTop = output.scrollHeight;
  }

  async function createSession(path: string): Promise<void> {
    const bridge = window.selfmeLab;
    if (!bridge) return;
    try {
      const created = await bridge.createAgentSession(runtimeId, path);
      store.addSession(created);
      setShowDeletedSessions(false);
      setPrompt("");
      setLocalError(null);
      if (provider?.configured) await connect(created.id);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  }

  async function chooseWorkspace(): Promise<void> {
    if (!window.selfmeLab) return;
    if (anyBusy) { setLocalError("当前任务仍在运行，请先完成或取消后新建会话"); return; }
    try {
      const selected = await window.selfmeLab.chooseWorkspace();
      if (selected) await createSession(selected);
    } catch (error) { setLocalError(errorMessage(error)); }
  }

  async function newSession(): Promise<void> {
    if (anyBusy) { setLocalError("当前任务仍在运行，请先完成或取消后新建会话"); return; }
    const path = workspace ?? snapshot.lastWorkspace;
    if (path) await createSession(path);
    else await chooseWorkspace();
  }

  async function selectSession(next: AgentSessionSummary): Promise<void> {
    if (!window.selfmeLab) return;
    if (next.id === snapshot.selectedSessionId) {
      if (provider?.configured && !busy && snapshot.phase !== "ready") await connect(next.id);
      return;
    }
    if (anyBusy) { setLocalError("当前任务仍在运行，请先完成或取消后切换会话"); return; }
    store.select(next.id);
    setPrompt("");
    setLocalError(null);
    try {
      await window.selfmeLab.selectAgentSession(next.id);
      store.loadHistory(next.id, await window.selfmeLab.getAgentSessionEvents(next.id));
      if (provider?.configured) await connect(next.id);
    } catch (error) { setLocalError(errorMessage(error)); }
  }

  async function refreshSessionCatalog(): Promise<void> {
    if (!window.selfmeLab) return;
    const catalog = await window.selfmeLab.getAgentSessionCatalog(runtimeId);
    store.setCatalog(catalog);
    setPrompt("");
    if (catalog.selectedSessionId) {
      store.loadHistory(catalog.selectedSessionId, await window.selfmeLab.getAgentSessionEvents(catalog.selectedSessionId));
      if (provider?.configured) await connect(catalog.selectedSessionId);
    }
  }

  async function confirmSessionAction(): Promise<void> {
    if (!sessionAction || !window.selfmeLab) return;
    setSessionActionBusy(true);
    setRailError(null);
    try {
      if (sessionAction.kind === "delete") await window.selfmeLab.deleteAgentSession(sessionAction.id);
      else await window.selfmeLab.purgeAgentSession(sessionAction.id);
      setSessionAction(null);
      await refreshSessionCatalog();
    } catch (error) {
      setRailError(errorMessage(error));
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function restoreSession(id: string): Promise<void> {
    if (!window.selfmeLab) return;
    setRailError(null);
    try {
      await window.selfmeLab.restoreAgentSession(id);
      await refreshSessionCatalog();
      setShowDeletedSessions(false);
    } catch (error) { setRailError(errorMessage(error)); }
  }

  async function submit(): Promise<void> {
    const text = prompt.trim();
    if (!text || !window.selfmeLab || submittingRef.current) return;
    if (!snapshot.selectedSessionId) { await chooseWorkspace(); return; }
    if (!provider?.configured) { onOpenSettings?.(); return; }
    const steering = ["running", "approval"].includes(snapshot.phase);
    if (snapshot.phase !== "ready" && !steering) {
      setLocalError(`${names[runtimeId]} 尚未就绪，请稍等或检查连接状态`);
      return;
    }
    setPrompt("");
    submittingRef.current = true;
    setSubmitting(true);
    setLocalError(null);
    followOutputRef.current = true;
    setShowLatest(false);
    try {
      if (steering) await window.selfmeLab.steerSessionPrompt(snapshot.selectedSessionId, text);
      else await window.selfmeLab.sendSessionPrompt(snapshot.selectedSessionId, text);
    } catch (error) {
      setPrompt((current) => current || text);
      setLocalError(errorMessage(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function approve(requestId: string | number, optionId: string): Promise<void> {
    if (!window.selfmeLab || !snapshot.selectedSessionId) return;
    setApprovalBusy(true);
    try {
      await window.selfmeLab.respondSessionApproval(snapshot.selectedSessionId, requestId, optionId);
      store.removeApproval(snapshot.selectedSessionId, requestId);
      setLocalError(null);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setApprovalBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    try {
      if (!snapshot.selectedSessionId) return;
      await window.selfmeLab?.cancelSessionRun(snapshot.selectedSessionId);
      store.removeAllApprovals(snapshot.selectedSessionId);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  }

  const busy = (connectingSessionId !== null && connectingSessionId === snapshot.selectedSessionId) || busyPhases.has(snapshot.phase);
  const anyBusy = connectingSessionId !== null || snapshot.sessions.some((item) => busyPhases.has(item.phase));
  const canSteer = ["running", "approval"].includes(snapshot.phase);
  const composerHint = !workspace ? "先选择工作目录" : !provider?.configured ? "先配置模型 API Key" : canSteer ? "补充要求或纠正方向，接入当前任务" : busy ? "正在连接或取消，请稍候" : "描述任务或提出问题";
  const lastPromptIndex = snapshot.entries.reduce((index, entry, current) => entry.kind === "user" && entry.deliveryMode !== "steer" ? current : index, -1);
  const activeEntries = snapshot.entries.slice(lastPromptIndex + 1);
  const activeTool = [...activeEntries].reverse().find((entry) => entry.kind === "tool" && ["pending", "in_progress", "inProgress", "running"].includes(entry.toolStatus ?? ""));
  const liveStatus = snapshot.phase === "approval" ? "等待审批后继续" : activeTool ? `${presentEntry(activeTool).label} · ${presentEntry(activeTool).summary}` : snapshot.statusText;
  const transcriptEntries = visibleTranscriptEntries(snapshot.entries).filter((entry) =>
    entry.kind !== "thought" && (entry.kind !== "turn_end" || entry.hasExecutionActivity),
  );
  const runningSince = ["running", "approval", "cancelling"].includes(snapshot.phase) ? snapshot.entries[lastPromptIndex]?.at : undefined;

  return (
    <div className={`dsh-workspace agent-workspace--${runtimeId}`}>
      <div className="dsh-workspace__masthead">
        <div className="dsh-workspace__identity"><LabIcon runtimeId={runtimeId} /><h1>{names[runtimeId]} LAB</h1></div>
        <button className="dsh-workspace__path" disabled={anyBusy} onClick={() => void chooseWorkspace()} type="button" title="选择工作目录并新建会话">
          <span>WORKSPACE</span><strong>{workspace ?? "选择工作目录"}</strong>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M2 5h7l2 2h11v13H2zM2 9h20" /></svg>
        </button>
      </div>
      <div className="dsh-workspace__grid">
        <aside className="dsh-rail">
          <div className="dsh-rail__heading"><span>SESSIONS</span><button onClick={() => void newSession()} disabled={anyBusy} title="新建会话" type="button">＋</button></div>
          <div className="dsh-rail__switch" role="group" aria-label="会话列表类型">
            <button className={!showDeletedSessions ? "is-active" : ""} onClick={() => setShowDeletedSessions(false)} type="button">会话 <small>{snapshot.sessions.length}</small></button>
            <button className={showDeletedSessions ? "is-active" : ""} onClick={() => setShowDeletedSessions(true)} type="button">最近删除 <small>{snapshot.deletedSessions.length}</small></button>
          </div>
          {railError && <p className="dsh-rail__error" role="alert">{railError}</p>}
          <div className="dsh-rail__scroll">{showDeletedSessions ? (
            snapshot.deletedSessions.length ? snapshot.deletedSessions.map((item) => (
              <div className="dsh-rail__session is-deleted" key={item.id} title={item.workspace}>
                <strong>{item.title}</strong><small>{item.workspace}</small>
                <div className="dsh-rail__deleted-actions">
                  <button type="button" onClick={() => void restoreSession(item.id)}>恢复</button>
                  <button type="button" onClick={() => setSessionAction({ id: item.id, title: item.title, kind: "purge" })}>彻底删除</button>
                </div>
              </div>
            )) : <p className="dsh-rail__empty">最近删除中没有会话</p>
          ) : snapshot.sessions.length ? snapshot.sessions.map((item) => (
            <div className={`dsh-rail__session${item.id === snapshot.selectedSessionId ? " is-selected" : ""}`} key={item.id}>
              <button className="dsh-rail__session-main" disabled={anyBusy && item.id !== snapshot.selectedSessionId} onClick={() => void selectSession(item)} title={`${item.workspace}\n${item.statusText}`} type="button">
                <i className={`is-${item.phase}`} aria-hidden="true" /><span>{item.title}</span><small className="dsh-rail__session-meta"><span>{sessionStateLabel(item.phase)}</span><time dateTime={item.lastActivityAt ?? item.createdAt} title={`${item.lastActivityAt ? "最后活动" : "创建于"} ${exactTime(item.lastActivityAt ?? item.createdAt) ?? ""}`}>{sessionTimeLabel(item.lastActivityAt ?? item.createdAt, today)}</time></small>
              </button>
              <button className="dsh-rail__session-delete" disabled={busyPhases.has(item.phase)} onClick={() => setSessionAction({ id: item.id, title: item.title, kind: "delete" })} title="移至最近删除" aria-label={`删除会话：${item.title}`} type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg></button>
            </div>
          )) : <p className="dsh-rail__empty">选择工作目录，创建第一个会话</p>}</div>
        </aside>
        <section className="dsh-conversation" aria-label={`${names[runtimeId]} 工作区`}>
          <div className="dsh-conversation__scroll" ref={outputRef} onScroll={trackOutputScroll}>
            {snapshot.entries.length === 0 && <div className="dsh-conversation__empty">
              <LabIcon runtimeId={runtimeId} /><h2>准备好让 {names[runtimeId]} 开始工作</h2>
              <p>{!workspace ? runtimeId === "pi" ? "选择工作目录；Pi 的文件工具限定在此，命令执行另需审批。" : "选择一个工作目录，运行会限定在该目录中。" : !provider?.configured ? "配置模型地址和 API Key 后即可开始。" : connectingSessionId !== null && connectingSessionId === snapshot.selectedSessionId ? `正在连接本地 ${names[runtimeId]} 运行时…` : "描述一项任务，实时查看输出、工具调用与审批。"}</p>
              {!workspace && <button onClick={() => void chooseWorkspace()} type="button">选择工作目录</button>}
              {workspace && !provider?.configured && <button onClick={onOpenSettings} type="button">配置模型</button>}
            </div>}
            {transcriptEntries.map((entry, index) => {
              const day = calendarDayKey(entry.at);
              const previousDay = index > 0 ? calendarDayKey(transcriptEntries[index - 1].at) : null;
              return <Fragment key={entry.id}>
                {day && day !== previousDay && <div className="dsh-conversation__date" role="separator"><span>{dateDividerLabel(entry.at, today)}</span></div>}
                <TranscriptItem entry={entry} runtimeId={runtimeId} workspace={workspace} onApprove={(requestId, optionId) => void approve(requestId, optionId)} approvalBusy={approvalBusy} />
              </Fragment>;
            })}
            {localError && <div className="dsh-error" role="alert">{localError}</div>}
          </div>
          {showLatest && <button className="dsh-scroll-jump" onClick={jumpToLatest} type="button">最新输出 ↓</button>}
          {busy && <div className="dsh-live-status"><span className="dsh-activity__dots" aria-hidden="true"><i /><i /><i /></span><span role="status">{liveStatus}</span><small>{snapshot.phase === "approval" ? "需要你的决定" : "实时工作中"}</small>{runningSince && <RunElapsed startedAt={runningSince} />}</div>}
          <div className="dsh-composer">
            <div className="dsh-composer__field">
              <textarea ref={promptRef} aria-label="任务内容" title="Enter 发送 · Shift+Enter 换行" onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} placeholder={composerHint} value={prompt} rows={1} />
              {["running", "approval", "cancelling"].includes(snapshot.phase) && <button className="dsh-composer__cancel" disabled={snapshot.phase === "cancelling"} onClick={() => void cancel()} type="button" title="取消当前任务" aria-label="取消当前任务"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg></button>}
              <button className="dsh-composer__send" disabled={!prompt.trim() || submitting || busy && !canSteer} onClick={() => void submit()} type="button" title={canSteer ? "补充指令 · 在安全节点接入当前任务" : "发送任务"} aria-label={canSteer ? "补充指令" : "发送任务"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M3 11.5 21 3l-5.5 18-3.9-7.1L3 11.5Z" /><path d="m11.6 13.9 4.9-5" /></svg></button>
            </div>
          </div>
        </section>
      </div>
      {sessionAction && <div className="dsh-session-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !sessionActionBusy) setSessionAction(null); }}>
        <section className="dsh-session-modal" role="dialog" aria-modal="true" aria-labelledby="session-action-title">
          <span>{sessionAction.kind === "purge" ? "PERMANENT DELETE" : "MOVE TO RECENTLY DELETED"}</span>
          <h2 id="session-action-title">{sessionAction.kind === "purge" ? "彻底删除这个会话？" : "将这个会话移至最近删除？"}</h2>
          <p className="dsh-session-modal__name">{sessionAction.title}</p>
          <p>{sessionAction.kind === "purge" ? "对话记录及本应用保存的 Harness 上下文将无法恢复。工作目录和其中的文件不会受影响。" : "会话将从列表隐藏，内容和 Harness 上下文仍保留，可随时恢复。工作目录不会受影响。"}</p>
          <div><button type="button" autoFocus disabled={sessionActionBusy} onClick={() => setSessionAction(null)}>取消</button><button className={sessionAction.kind === "purge" ? "is-danger" : ""} type="button" disabled={sessionActionBusy} onClick={() => void confirmSessionAction()}>{sessionActionBusy ? "处理中…" : sessionAction.kind === "purge" ? "彻底删除" : "移至最近删除"}</button></div>
        </section>
      </div>}
    </div>
  );
}
