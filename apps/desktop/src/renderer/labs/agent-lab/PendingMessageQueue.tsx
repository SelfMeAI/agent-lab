import { useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import type { AgentSessionQueue, PendingAgentMessage } from "../../../../../../packages/contracts/src/index";

interface Props { sessionId: string; queue: AgentSessionQueue; canSteer: boolean; canResume: boolean; stopping: boolean; running: boolean; configured: boolean }

/** Only unsent/recovery items are shown here; admitted Steer is ordinary chat. */
export function PendingMessageQueue({ sessionId, queue, canSteer, canResume, stopping, running, configured }: Props): JSX.Element | null {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; right: number; bottom: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const actionRef = useRef(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const messages = queue.messages.filter((item) => item.state !== "awaiting");
  const unconfirmed = messages.some((item) => item.state === "unconfirmed");
  const resumeHint = stopping ? "停止完成后可继续队列" : !canResume ? "当前操作完成后可继续队列" : unconfirmed ? "先处理发送未确认的消息" : editing ? "先保存或取消编辑" : !configured ? "先配置模型连接" : running ? "恢复自动发送，当前轮结束后继续" : "开始依次发送队列中的消息";
  const queueHint = stopping ? "停止后保留待发消息" : editing ? "编辑期间不会自动发送" : queue.paused ? running ? "当前轮继续工作，队列暂不发送" : "待发消息已保留，不会自动发送" : running ? "当前轮结束后依次发送" : "按队列顺序依次发送";

  useEffect(() => { setEditing(null); setRetrying(null); setError(null); setMenu(null); }, [sessionId]);
  useEffect(() => { if (editing) editRef.current?.focus(); }, [editing?.id]);
  useEffect(() => {
    if (retrying && !messages.some((item) => item.id === retrying)) setRetrying(null);
  }, [queue, retrying]);
  useEffect(() => {
    if (menu && !messages.some(item => item.id === menu.id && item.state === "queued")) setMenu(null);
  }, [queue, menu]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node) && !menuTriggerRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") { event.preventDefault(); setMenu(null); menuTriggerRef.current?.focus(); }
    };
    const resize = (): void => setMenu(null);
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape); window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); window.removeEventListener("resize", resize); };
  }, [menu]);

  function toggleMenu(button: HTMLButtonElement, item: PendingAgentMessage): void {
    if (menu?.id === item.id) { setMenu(null); return; }
    menuTriggerRef.current = button;
    const bounds = button.getBoundingClientRect();
    setMenu({ id: item.id, right: Math.max(8, window.innerWidth - bounds.right), bottom: Math.max(8, window.innerHeight - bounds.top + 6) });
  }

  async function act(action: () => Promise<unknown>): Promise<boolean> {
    if (actionRef.current) return false;
    actionRef.current = true; setBusy(true); setError(null);
    try { await action(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { actionRef.current = false; setBusy(false); }
  }

  async function edit(item: PendingAgentMessage): Promise<void> {
    // An open editor must not race automatic draining at the end of a turn.
    if (await act(() => window.agentLab!.pauseSessionQueue(sessionId))) setEditing({ id: item.id, text: item.text });
  }

  async function save(): Promise<void> {
    if (!editing?.text.trim()) return;
    if (await act(() => window.agentLab!.editQueuedSessionPrompt(sessionId, editing.id, editing.text))) setEditing(null);
  }

  if (!messages.length && !error && !editing) return null;
  return <section className={`agent-queue${queue.paused ? " is-paused" : ""}`} aria-label="待发送消息">
    <div className="agent-queue__heading">
      <span className="agent-queue__title"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" /></svg><strong>待发送</strong><small>{messages.length}</small>{queue.paused && <em>已暂停</em>}</span>
      <small className="agent-queue__hint" title={queueHint}>{queueHint}</small>
      {queue.paused ? <button className="agent-queue__control" type="button" disabled={busy || !canResume || unconfirmed || !!editing || !configured} title={resumeHint} onClick={() => void act(() => window.agentLab!.resumeSessionQueue(sessionId))}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="m6 4 6 4-6 4z" /></svg>继续队列</button>
        : <button className="agent-queue__control" type="button" disabled={busy} title="只暂停队列自动发送，当前轮继续工作" onClick={() => void act(() => window.agentLab!.pauseSessionQueue(sessionId))}><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="2.5" height="8" rx=".7" /><rect x="9.5" y="4" width="2.5" height="8" rx=".7" /></svg>暂停队列</button>}
    </div>
    <div className="agent-queue__list" onScroll={() => setMenu(null)}>{messages.map((item, index) => <div className={`agent-queue__item${item.state === "unconfirmed" ? " is-unconfirmed" : ""}`} key={item.id}>
      {editing?.id === item.id ? <div className="agent-queue__editor">
        <textarea ref={editRef} aria-label="编辑待发送消息" value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") { event.preventDefault(); setEditing(null); }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void save(); }
        }} rows={3} />
        <div><small>Shift+Enter 换行 · 保存后可继续队列</small><button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button><button type="button" disabled={busy || !editing.text.trim()} onClick={() => void save()}>保存</button></div>
      </div> : <>
        <span className="agent-queue__number" aria-hidden="true">{item.state === "sending" ? <i className="agent-queue__spinner" /> : index + 1}</span>
        <div className="agent-queue__content"><details><summary title={item.text}>{item.text}</summary><p>{item.text}</p></details>
          {item.state === "unconfirmed" && <small title={item.detail}>发送未确认 · 重发前请检查对话</small>}
          {item.state === "queued" && item.detail && <small title={item.detail}>未提交 · 可编辑后继续</small>}
        </div>
        <div className="agent-queue__actions">
          {item.state === "queued" && <button className="agent-queue__steer" type="button" disabled={busy || !canSteer || !!editing} title={stopping ? "当前轮正在停止，不能补充" : editing ? "先保存或取消编辑" : !canSteer ? "当前没有可补充的工作轮次" : "只将这条消息补充到当前轮"} onClick={() => void act(() => window.agentLab!.steerQueuedSessionPrompt(sessionId, item.id))}>Steer<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12 12 4M5 4h7v7" /></svg></button>}
          {item.state === "unconfirmed" && <button type="button" disabled={busy || !!editing} onClick={() => setRetrying(retrying === item.id ? null : item.id)}>重发…</button>}
          {item.state === "queued" && <button className="agent-queue__more" type="button" disabled={busy || !!editing} aria-label={`消息 ${index + 1} 的操作`} title="编辑、排序或删除" aria-haspopup="menu" aria-expanded={menu?.id === item.id} onClick={(event) => toggleMenu(event.currentTarget, item)}><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="13" cy="8" r="1" /></svg></button>}
          {item.state === "unconfirmed" && <button type="button" disabled={busy || !!editing} title="从队列移除，不会撤回已提交的内容" onClick={() => void act(() => window.agentLab!.deleteQueuedSessionPrompt(sessionId, item.id))}>移除</button>}
        </div>
        {retrying === item.id && <div className="agent-queue__retry" role="alert"><p>这条消息可能已接入。确认尚未执行后再重发，避免重复操作。</p><div><button type="button" disabled={busy} autoFocus onClick={() => setRetrying(null)}>取消</button><button type="button" disabled={busy} onClick={() => void act(() => window.agentLab!.retryQueuedSessionPrompt(sessionId, item.id)).then((ok) => { if (ok) setRetrying(null); })}>确认重新排队</button></div></div>}
      </>}
    </div>)}</div>
    {editing && !messages.some((item) => item.id === editing.id) && <div className="agent-queue__editor"><p>消息已提交，未保存的修改仍在此处，可复制后另行发送。</p><textarea aria-label="未保存的修改" value={editing.text} readOnly /><button type="button" onClick={() => setEditing(null)}>关闭</button></div>}
    {error && <p className="agent-queue__error" role="alert">{error}<button type="button" aria-label="关闭队列错误" onClick={() => setError(null)}>×</button></p>}
    {menu && createPortal(<div className="agent-queue-popover" role="menu" aria-label="队列消息操作" ref={menuRef} style={{ right: menu.right, bottom: menu.bottom }} onKeyDown={(event) => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
      if (event.key === "Tab") setMenu(null);
    }}>
      <button type="button" role="menuitem" onClick={() => { const item = messages.find(item => item.id === menu.id); setMenu(null); if (item) void edit(item); }}>编辑</button>
      <button type="button" role="menuitem" disabled={messages.findIndex(item => item.id === menu.id) <= 0 || messages[messages.findIndex(item => item.id === menu.id) - 1]?.state !== "queued"} onClick={() => { const id = menu.id; setMenu(null); void act(() => window.agentLab!.moveQueuedSessionPrompt(sessionId, id, "up")); }}>上移 <span>↑</span></button>
      <button type="button" role="menuitem" disabled={messages.findIndex(item => item.id === menu.id) >= messages.length - 1 || messages[messages.findIndex(item => item.id === menu.id) + 1]?.state !== "queued"} onClick={() => { const id = menu.id; setMenu(null); void act(() => window.agentLab!.moveQueuedSessionPrompt(sessionId, id, "down")); }}>下移 <span>↓</span></button>
      <button className="is-danger" type="button" role="menuitem" onClick={() => { const id = menu.id; setMenu(null); void act(() => window.agentLab!.deleteQueuedSessionPrompt(sessionId, id)); }}>删除</button>
    </div>, document.body)}
  </section>;
}
