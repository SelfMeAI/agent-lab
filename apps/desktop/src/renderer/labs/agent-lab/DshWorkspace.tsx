import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX } from "react";
import type { ProviderStatus } from "../../../../../../packages/contracts/src/index";
import { LabIcon } from "../../shell/LabIcon";
import {
  addDshUserPrompt, clearDshTranscript, getDshSnapshot, removeAllDshApprovals, removeDshApproval,
  subscribeDshStore, type TranscriptEntry,
} from "./dsh-store";

const workspaceKey = "selfme-lab:dsh-workspace";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function TranscriptItem({ entry, onApprove, approvalBusy }: {
  entry: TranscriptEntry;
  onApprove(requestId: string | number, optionId: string): void;
  approvalBusy: boolean;
}): JSX.Element {
  if (entry.kind === "user") return (
    <article className="dsh-entry dsh-entry--user">
      <div className="dsh-entry__avatar dsh-entry__avatar--user" aria-hidden="true">◯</div>
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
            type="button"
          >{option.name}</button>
        ))}
      </div>
    </article>
  );
  if (entry.kind === "tool" || entry.kind === "status") return (
    <details className="dsh-tool">
      <summary>
        <span className="dsh-tool__glyph" aria-hidden="true">⌁</span>
        <strong>{entry.title ?? (entry.kind === "tool" ? "工具调用" : "运行详情")}</strong>
        <span className="dsh-tool__status">{entry.toolStatus ?? (entry.kind === "tool" ? "运行中" : "UPDATE")}</span>
        <span className="dsh-tool__chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="dsh-tool__details">
        {entry.text && <p>{entry.text}</p>}
        {entry.raw !== undefined && <pre>{JSON.stringify(entry.raw, null, 2)}</pre>}
      </div>
    </details>
  );
  if (entry.kind === "error") return <div className="dsh-error" role="alert">{entry.text}</div>;
  if (entry.kind === "thought") return (
    <details className="dsh-thought"><summary>THOUGHT · 展开查看</summary><p>{entry.text}</p></details>
  );
  return (
    <article className="dsh-entry dsh-entry--agent">
      <LabIcon className="dsh-entry__avatar" runtimeId="dsh" />
      <div className="dsh-entry__body"><span className="dsh-entry__label">DSH · LIVE OUTPUT</span><p>{entry.text}</p></div>
    </article>
  );
}

export function DshWorkspace({ onOpenSettings, providerRevision = 0 }: {
  onOpenSettings?(): void;
  providerRevision?: number;
}): JSX.Element {
  const [workspace, setWorkspace] = useState(() => localStorage.getItem(workspaceKey));
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const snapshot = useSyncExternalStore(subscribeDshStore, getDshSnapshot);
  const bottomRef = useRef<HTMLDivElement>(null);

  const connect = useCallback(async (path: string): Promise<void> => {
    if (!window.selfmeLab) return;
    setConnecting(true);
    setLocalError(null);
    try {
      await window.selfmeLab.startRuntime("dsh", path);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setConnecting(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (window.selfmeLab) {
      void window.selfmeLab.getProviderStatus("dsh").then((status) => {
        if (!active) return;
        setProvider(status);
        if (status.configured && workspace) void connect(workspace);
      }).catch((error: unknown) => { if (active) setLocalError(errorMessage(error)); });
    }
    return () => { active = false; };
  }, [connect, providerRevision]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [snapshot.entries]);

  async function chooseWorkspace(): Promise<void> {
    const bridge = window.selfmeLab;
    if (!bridge) return;
    if (busy) { setLocalError("当前任务仍在运行，请先完成或取消后切换工作目录"); return; }
    try {
      const selected = await bridge.chooseWorkspace();
      if (!selected || selected === workspace) return;
      await bridge.stopRuntime("dsh");
      clearDshTranscript();
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
      await window.selfmeLab.stopRuntime("dsh");
      clearDshTranscript();
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
      setLocalError("DSH 尚未就绪，请稍等或检查连接状态");
      return;
    }
    setPrompt("");
    setLocalError(null);
    addDshUserPrompt(text);
    try {
      await window.selfmeLab.sendPrompt("dsh", text);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  }

  async function approve(requestId: string | number, optionId: string): Promise<void> {
    if (!window.selfmeLab) return;
    setApprovalBusy(true);
    try {
      await window.selfmeLab.respondApproval("dsh", requestId, optionId);
      removeDshApproval(requestId);
      setLocalError(null);
    } catch (error) {
      setLocalError(errorMessage(error));
    } finally {
      setApprovalBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    try {
      await window.selfmeLab?.cancelRun("dsh");
      removeAllDshApprovals();
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  }

  const busy = connecting || ["starting", "running", "approval", "cancelling"].includes(snapshot.phase);
  const composerHint = !workspace ? "先选择工作目录" : !provider?.configured ? "先配置模型 API Key" : busy ? "任务执行中" : "Describe a task";

  return (
    <div className="dsh-workspace">
      <div className="dsh-workspace__masthead">
        <div className="dsh-workspace__identity"><LabIcon runtimeId="dsh" /><h1>DSH LAB</h1></div>
        <button className="dsh-workspace__path" disabled={busy} onClick={() => void chooseWorkspace()} type="button" title="选择工作目录">
          <span>WORKSPACE</span><strong>{workspace ?? "选择工作目录"}</strong>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M2 5h7l2 2h11v13H2zM2 9h20" /></svg>
        </button>
        <span className={`dsh-workspace__phase is-${snapshot.phase}`}>{connecting ? "CONNECTING" : snapshot.phase.toUpperCase()}</span>
      </div>
      <div className="dsh-workspace__grid">
        <aside className="dsh-rail">
          <div className="dsh-rail__heading"><span>RECENT</span><button onClick={() => void newSession()} disabled={!workspace || busy} title="新建会话" type="button">＋</button></div>
          {snapshot.currentTask ? <div className="dsh-rail__task"><i aria-hidden="true" /><span>{snapshot.currentTask}</span><small>当前会话</small></div> : <p className="dsh-rail__empty">开始第一项实验后会显示在这里</p>}
        </aside>
        <section className="dsh-conversation" aria-label="DSH 工作区">
          <div className="dsh-conversation__scroll">
            {snapshot.entries.length === 0 && <div className="dsh-conversation__empty">
              <LabIcon runtimeId="dsh" /><h2>准备好让 DSH 开始工作</h2>
              <p>{!workspace ? "选择一个工作目录，运行会限定在该目录中。" : !provider?.configured ? "配置模型地址和 API Key 后即可开始。" : connecting ? "正在连接本地 DSH 运行时…" : "描述一项任务，实时查看输出、工具调用与审批。"}</p>
              {!workspace && <button onClick={() => void chooseWorkspace()} type="button">选择工作目录</button>}
              {workspace && !provider?.configured && <button onClick={onOpenSettings} type="button">配置模型</button>}
            </div>}
            {snapshot.entries.map((entry) => <TranscriptItem key={entry.id} entry={entry} onApprove={(requestId, optionId) => void approve(requestId, optionId)} approvalBusy={approvalBusy} />)}
            {busy && <div className="dsh-activity"><span className="dsh-activity__dots" aria-hidden="true"><i /><i /><i /></span>{snapshot.statusText}</div>}
            {localError && <div className="dsh-error" role="alert">{localError}</div>}
            <div ref={bottomRef} />
          </div>
          <div className="dsh-composer">
            <textarea aria-label="任务内容" onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} placeholder={composerHint} value={prompt} rows={2} />
            {["running", "approval", "cancelling"].includes(snapshot.phase) ? <button className="dsh-composer__cancel" disabled={snapshot.phase === "cancelling"} onClick={() => void cancel()} type="button" title="取消当前任务">■</button> : <button className="dsh-composer__send" disabled={!prompt.trim() || connecting} onClick={() => void submit()} type="button" title="发送任务">➤</button>}
          </div>
        </section>
      </div>
    </div>
  );
}
