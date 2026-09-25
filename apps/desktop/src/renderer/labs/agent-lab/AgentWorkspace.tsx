import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ProviderStatus } from "../../../../../../packages/contracts/src/index";
import { LabIcon } from "../../shell/LabIcon";
import { agentStores, type AgentRuntimeId, type TranscriptEntry } from "./agent-store";
import { presentEntry, visibleTranscriptEntries } from "./tool-presentation";

const names = { dsh: "DSH", codex: "CODEX" } as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function AgentMarkdown({ text }: { text: string }): JSX.Element {
  return <div className="dsh-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, href }) => <span className="dsh-markdown__link" title={href}>{children ?? href}</span>,
    img: ({ alt }) => <span className="dsh-markdown__image">[图片：{alt || "未提供描述"}]</span>,
  }}>{text}</ReactMarkdown></div>;
}

function ToolItem({ entry, workspace }: { entry: TranscriptEntry; workspace: string | null }): JSX.Element {
  const view = presentEntry(entry);
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
      {(view.exitCode !== undefined || view.duration) && <p className="dsh-tool__meta">{view.exitCode !== undefined && `退出码 ${view.exitCode}`}{view.exitCode !== undefined && view.duration && " · "}{view.duration && `耗时 ${view.duration}`}</p>}
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
  if (entry.kind === "user") return (
    <article className="dsh-entry dsh-entry--user">
      <div className="dsh-entry__avatar dsh-entry__avatar--user" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="3.1" />
          <path d="M5.4 19c.6-3.4 2.9-5.1 6.6-5.1s6 1.7 6.6 5.1" />
        </svg>
      </div>
      <div className="dsh-entry__body"><span className="dsh-entry__label">YOU</span><p>{entry.text}</p></div>
    </article>
  );
  if (entry.kind === "approval" && entry.approval) return (
    <article className="dsh-approval">
      <span className="dsh-approval__mark" aria-hidden="true">!</span>
      <div className="dsh-approval__content">
        <strong>APPROVAL REQUIRED</strong>
        <p>{entry.text || entry.approval.title}</p>
        {entry.approval.toolCallId && <small>TOOL CALL · {entry.approval.toolCallId}</small>}
      </div>
      <div className="dsh-approval__actions">
        {entry.approval.options.map((option) => (
          <button
            className={option.kind.includes("allow") ? "is-allow" : "is-reject"}
            disabled={approvalBusy}
            key={option.optionId}
            onClick={() => onApprove(entry.approval!.requestId, option.optionId)}
            title={option.kind === "allow_session" ? "仅当前 Codex 会话有效，新会话会重新询问" : undefined}
            type="button"
          >{option.name}</button>
        ))}
      </div>
    </article>
  );
  if (entry.kind === "tool" || entry.kind === "status") return <ToolItem entry={entry} workspace={workspace} />;
  if (entry.kind === "error") return <div className="dsh-error" role="alert">{entry.text}</div>;
  return (
    <article className="dsh-entry dsh-entry--agent">
      <LabIcon className="dsh-entry__avatar" runtimeId={runtimeId} />
      <div className="dsh-entry__body"><span className="dsh-entry__label">{names[runtimeId]} · 回复</span><AgentMarkdown text={entry.text} /></div>
    </article>
  );
}

export function AgentWorkspace({ runtimeId, onOpenSettings, providerRevision = 0 }: {
  runtimeId: AgentRuntimeId;
  onOpenSettings?(): void;
  providerRevision?: number;
}): JSX.Element {
  const workspaceKey = `selfme-lab:${runtimeId}-workspace`;
  const store = agentStores[runtimeId];
  const [workspace, setWorkspace] = useState(() => localStorage.getItem(workspaceKey));
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const outputRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const followOutputRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  const connect = useCallback(async (path: string): Promise<void> => {
    if (!window.selfmeLab) return;
    setConnecting(true);
    setLocalError(null);
    try {
      await window.selfmeLab.startRuntime(runtimeId, path);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setConnecting(false);
    }
  }, [runtimeId]);

  useEffect(() => {
    let active = true;
    if (window.selfmeLab) {
      void window.selfmeLab.getProviderStatus(runtimeId).then((status) => {
        if (!active) return;
        setProvider(status);
        if (status.configured && workspace) void connect(workspace);
      }).catch((error: unknown) => { if (active) setLocalError(errorMessage(error)); });
    }
    return () => { active = false; };
  }, [connect, providerRevision]);

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

  async function chooseWorkspace(): Promise<void> {
    const bridge = window.selfmeLab;
    if (!bridge) return;
    if (busy) { setLocalError("当前任务仍在运行，请先完成或取消后切换工作目录"); return; }
    try {
      const selected = await bridge.chooseWorkspace();
      if (!selected || selected === workspace) return;
      await bridge.stopRuntime(runtimeId);
      store.clearTranscript();
      localStorage.setItem(workspaceKey, selected);
      setWorkspace(selected);
      if (provider?.configured) await connect(selected);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  }

  async function newSession(): Promise<void> {
    if (!workspace || !window.selfmeLab) return;
    try {
      await window.selfmeLab.stopRuntime(runtimeId);
      store.clearTranscript();
      if (provider?.configured) await connect(workspace);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  }

  async function submit(): Promise<void> {
    const text = prompt.trim();
    if (!text || !window.selfmeLab) return;
    if (!workspace) { await chooseWorkspace(); return; }
    if (!provider?.configured) { onOpenSettings?.(); return; }
    if (snapshot.phase !== "ready") {
      setLocalError(`${names[runtimeId]} 尚未就绪，请稍等或检查连接状态`);
      return;
    }
    setPrompt("");
    setLocalError(null);
    followOutputRef.current = true;
    setShowLatest(false);
    store.addUserPrompt(text);
    try {
      await window.selfmeLab.sendPrompt(runtimeId, text);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  }

  async function approve(requestId: string | number, optionId: string): Promise<void> {
    if (!window.selfmeLab) return;
    setApprovalBusy(true);
    try {
      await window.selfmeLab.respondApproval(runtimeId, requestId, optionId);
      store.removeApproval(requestId);
      setLocalError(null);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setApprovalBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    try {
      await window.selfmeLab?.cancelRun(runtimeId);
      store.removeAllApprovals();
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  }

  const busy = connecting || ["starting", "running", "approval", "cancelling"].includes(snapshot.phase);
  const composerHint = !workspace ? "先选择工作目录" : !provider?.configured ? "先配置模型 API Key" : busy ? "任务执行中" : "Describe a task";
  const lastPromptIndex = snapshot.entries.reduce((index, entry, current) => entry.kind === "user" ? current : index, -1);
  const activeEntries = snapshot.entries.slice(lastPromptIndex + 1);
  const activeTool = [...activeEntries].reverse().find((entry) => entry.kind === "tool" && ["pending", "in_progress", "inProgress", "running"].includes(entry.toolStatus ?? ""));
  const liveStatus = snapshot.phase === "approval" ? "等待审批后继续" : activeTool ? `${presentEntry(activeTool).label} · ${presentEntry(activeTool).summary}` : snapshot.statusText;

  return (
    <div className={`dsh-workspace agent-workspace--${runtimeId}`}>
      <div className="dsh-workspace__masthead">
        <div className="dsh-workspace__identity"><LabIcon runtimeId={runtimeId} /><h1>{names[runtimeId]} LAB</h1></div>
        <button className="dsh-workspace__path" disabled={busy} onClick={() => void chooseWorkspace()} type="button" title="选择工作目录">
          <span>WORKSPACE</span><strong>{workspace ?? "选择工作目录"}</strong>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M2 5h7l2 2h11v13H2zM2 9h20" /></svg>
        </button>
      </div>
      <div className="dsh-workspace__grid">
        <aside className="dsh-rail">
          <div className="dsh-rail__heading"><span>SESSION</span><button onClick={() => void newSession()} disabled={!workspace || busy} title="新建会话" type="button">＋</button></div>
          <div className="dsh-rail__scroll">{snapshot.currentTask ? <div className="dsh-rail__task"><i aria-hidden="true" /><span>{snapshot.currentTask}</span><small>当前会话</small></div> : <p className="dsh-rail__empty">开始第一项实验后会显示在这里</p>}</div>
        </aside>
        <section className="dsh-conversation" aria-label={`${names[runtimeId]} 工作区`}>
          <div className="dsh-conversation__scroll" ref={outputRef} onScroll={trackOutputScroll}>
            {snapshot.entries.length === 0 && <div className="dsh-conversation__empty">
              <LabIcon runtimeId={runtimeId} /><h2>准备好让 {names[runtimeId]} 开始工作</h2>
              <p>{!workspace ? "选择一个工作目录，运行会限定在该目录中。" : !provider?.configured ? "配置模型地址和 API Key 后即可开始。" : connecting ? `正在连接本地 ${names[runtimeId]} 运行时…` : "描述一项任务，实时查看输出、工具调用与审批。"}</p>
              {!workspace && <button onClick={() => void chooseWorkspace()} type="button">选择工作目录</button>}
              {workspace && !provider?.configured && <button onClick={onOpenSettings} type="button">配置模型</button>}
            </div>}
            {visibleTranscriptEntries(snapshot.entries).filter((entry) => entry.kind !== "thought").map((entry) => <TranscriptItem key={entry.id} entry={entry} runtimeId={runtimeId} workspace={workspace} onApprove={(requestId, optionId) => void approve(requestId, optionId)} approvalBusy={approvalBusy} />)}
            {localError && <div className="dsh-error" role="alert">{localError}</div>}
          </div>
          {showLatest && <button className="dsh-scroll-jump" onClick={jumpToLatest} type="button">最新输出 ↓</button>}
          {busy && <div className="dsh-live-status" role="status"><span className="dsh-activity__dots" aria-hidden="true"><i /><i /><i /></span><span>{liveStatus}</span><small>{snapshot.phase === "approval" ? "需要你的决定" : "实时工作中"}</small></div>}
          <div className="dsh-composer">
            <div className="dsh-composer__field">
              <textarea ref={promptRef} aria-label="任务内容" title="Enter 发送 · Shift+Enter 换行" onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} placeholder={composerHint} value={prompt} rows={1} />
              {["running", "approval", "cancelling"].includes(snapshot.phase) ? <button className="dsh-composer__cancel" disabled={snapshot.phase === "cancelling"} onClick={() => void cancel()} type="button" title="取消当前任务" aria-label="取消当前任务"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg></button> : <button className="dsh-composer__send" disabled={!prompt.trim() || connecting} onClick={() => void submit()} type="button" title="发送任务" aria-label="发送任务"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M3 11.5 21 3l-5.5 18-3.9-7.1L3 11.5Z" /><path d="m11.6 13.9 4.9-5" /></svg></button>}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
