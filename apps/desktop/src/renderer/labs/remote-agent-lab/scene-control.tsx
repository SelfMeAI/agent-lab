import { useEffect, useRef, useState, type JSX } from "react";
import type { RemoteDesktopGrant } from "../../../../../../packages/contracts/src/remote-agent";
import { remoteError } from "./service-presentation";

/** One control lease for all views. A tab switch is never an acquire/release. */
export function useSceneControl(taskId: string, enabled: boolean, humanControl: boolean, returning: boolean, onReturningChange: (value: boolean) => void) {
  const [grant, setGrant] = useState<RemoteDesktopGrant>();
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [error, setError] = useState("");
  const [followUp, setFollowUp] = useState("");
  const alive = useRef(false), lock = useRef(false), version = useRef(0);
  useEffect(() => {
    alive.current = true; const ticket = ++version.current;
    setGrant(undefined); setError(""); setBusy(false); setConfirm(false); setFollowUp(""); lock.current = false;
    if (enabled) void window.selfmeLab!.observeRemoteDesktop("openclaw", taskId, false).then(value => { if (alive.current && version.current === ticket) setGrant(value); }).catch(cause => { if (alive.current && version.current === ticket) setError(remoteError(cause)); });
    return () => { alive.current = false; ++version.current; };
  }, [taskId, enabled]);
  async function observe(control: boolean): Promise<void> {
    if (!enabled || lock.current) return;
    const ticket = ++version.current; lock.current = true; setBusy(true); setError("");
    try {
      const value = await window.selfmeLab!.observeRemoteDesktop("openclaw", taskId, control);
      if (alive.current && ticket === version.current) { setGrant(value); setConfirm(false); }
    } catch (cause) { if (alive.current && ticket === version.current) setError(remoteError(cause)); }
    finally { if (alive.current && ticket === version.current) { lock.current = false; setBusy(false); } }
  }
  async function handBack(continueWork: boolean): Promise<void> {
    if (!enabled || lock.current) return;
    const ticket = ++version.current; lock.current = true; setBusy(true); setError("");
    try {
      const value = await window.selfmeLab!.returnRemoteDesktop("openclaw", taskId, continueWork ? followUp.trim() || "继续当前任务。" : undefined);
      if (alive.current && ticket === version.current) { setGrant(value); onReturningChange(false); setFollowUp(""); }
    } catch (cause) { if (alive.current && ticket === version.current) setError(remoteError(cause)); }
    finally { if (alive.current && ticket === version.current) { lock.current = false; setBusy(false); } }
  }
  const inputEnabled = humanControl && grant?.control === true && !busy && !confirm && !returning;
  return { grant, busy, confirm, error, followUp, inputEnabled, setConfirm, setFollowUp, observe, handBack };
}

export function SceneControlDialog({ returning, busy, followUp, onFollowUp, onCancel, onAcquire, onReturn }: {
  returning: boolean; busy: boolean; followUp: string; onFollowUp(value: string): void;
  onCancel(): void; onAcquire(): void; onReturn(continueWork: boolean): void;
}): JSX.Element {
  return <div className="remote-control-dialog-backdrop"><div className="remote-inline-confirm" role="dialog" aria-modal="true" aria-label={returning ? "交还远端控制" : "确认手动接管"}>
    <h3>{returning ? "交还控制" : "手动接管"}</h3>
    <p>{returning ? "交还后，桌面、浏览器和人工终端恢复只读。可以等待新指令，或让智能体继续。" : "将停止此引擎正在执行的任务。确认停稳后，桌面、浏览器和人工终端一起交给你操作。"}</p>
    {returning && <textarea rows={3} aria-label="交还后的补充要求" placeholder="刚才做了什么，接下来希望怎么继续（可选）" value={followUp} onChange={event => onFollowUp(event.target.value)} />}
    <div><button type="button" className="remote-button" disabled={busy} onClick={onCancel}>取消</button>
      {returning ? <><button type="button" className="remote-button" disabled={busy} onClick={() => onReturn(false)}>交还，等待指令</button><button type="button" className="remote-button remote-button--primary" disabled={busy} onClick={() => onReturn(true)}>交还并继续</button></> : <button type="button" className="remote-button remote-button--primary" disabled={busy} onClick={onAcquire}>{busy ? "正在停止…" : "停止并接管"}</button>}
    </div>
  </div></div>;
}
