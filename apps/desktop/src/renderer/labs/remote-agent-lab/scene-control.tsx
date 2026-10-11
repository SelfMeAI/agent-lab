import { useEffect, useRef, useState, type JSX } from "react";
import type { RemoteDesktopGrant, RemoteSceneAccess } from "../../../../../../packages/contracts/src/remote-agent";
import { remoteError } from "./service-presentation";

/** One control lease for all views. A tab switch is never an acquire/release. */
export function sceneInputEnabled(scene: RemoteSceneAccess | undefined, connected: boolean, busy: boolean, dialog: boolean): boolean {
  return connected && scene?.inputAllowed === true && !busy && !dialog;
}
export function sceneControlLabel(scene: RemoteSceneAccess | undefined): string {
  if (!scene) return "正在同步现场…";
  if (scene.humanControl) return "人工接管中";
  if (scene.agentBusy) return "智能体工作中 · 只读";
  return scene.inputAllowed ? "空闲 · 可操作" : "现场暂不可操作";
}
export function useSceneControl(taskId: string, enabled: boolean, snapshotAccess: RemoteSceneAccess | undefined, returning: boolean, onReturningChange: (value: boolean) => void) {
  const [grant, setGrant] = useState<RemoteDesktopGrant>();
  const [scene, setScene] = useState<RemoteSceneAccess>();
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [error, setError] = useState("");
  const [followUp, setFollowUp] = useState("");
  const alive = useRef(false), lock = useRef(false), version = useRef(0);
  const grantRef = useRef(grant); grantRef.current = grant;
  useEffect(() => {
    alive.current = true; const ticket = ++version.current;
    setGrant(undefined); setScene(undefined); setError(""); setBusy(false); setConfirm(false); setFollowUp(""); lock.current = false;
    if (enabled) void window.selfmeLab!.observeRemoteDesktop("openclaw", taskId, false).then(value => { if (alive.current && version.current === ticket) { setGrant(value); setScene(value.scene); } }).catch(cause => { if (alive.current && version.current === ticket) setError(remoteError(cause)); });
    return () => { alive.current = false; ++version.current; };
  }, [taskId, enabled]);
  useEffect(() => { if (snapshotAccess) setScene(snapshotAccess); }, [snapshotAccess]);
  useEffect(() => {
    if (!enabled) return;
    let active = true, querying = false;
    const poll = async () => {
      if (querying || lock.current) return; querying = true;
      const ticket = version.current;
      try {
        const state = await window.selfmeLab!.getRemoteSceneAccess("openclaw", taskId);
        if (!active || !alive.current || version.current !== ticket) return;
        setScene(state);
        if (grantRef.current && grantRef.current.control !== state.inputAllowed && !lock.current) await observe(false);
      } catch (cause) { if (active && alive.current && version.current === ticket) { setScene(undefined); setError(remoteError(cause)); } }
      finally { querying = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, [taskId, enabled]);
  async function observe(control: boolean): Promise<void> {
    if (!enabled || lock.current) return;
    const ticket = ++version.current; lock.current = true; setBusy(true); setError("");
    try {
      const value = await window.selfmeLab!.observeRemoteDesktop("openclaw", taskId, control);
      if (alive.current && ticket === version.current) { setGrant(value); setScene(value.scene); setConfirm(false); }
    } catch (cause) { if (alive.current && ticket === version.current) setError(remoteError(cause)); }
    finally { if (alive.current && ticket === version.current) { lock.current = false; setBusy(false); } }
  }
  async function handBack(continueWork: boolean): Promise<void> {
    if (!enabled || lock.current) return;
    const ticket = ++version.current; lock.current = true; setBusy(true); setError("");
    try {
      const value = await window.selfmeLab!.returnRemoteDesktop("openclaw", taskId, continueWork ? followUp.trim() || "继续当前任务。" : undefined);
      if (alive.current && ticket === version.current) { setGrant(value); setScene(value.scene); onReturningChange(false); setFollowUp(""); }
    } catch (cause) { if (alive.current && ticket === version.current) setError(remoteError(cause)); }
    finally { if (alive.current && ticket === version.current) { lock.current = false; setBusy(false); } }
  }
  const inputEnabled = sceneInputEnabled(scene, grant?.control === true, busy, confirm || returning);
  return { grant, scene, busy, confirm, error, followUp, inputEnabled, setConfirm, setFollowUp, observe, handBack };
}

export function SceneControlDialog({ returning, busy, followUp, onFollowUp, onCancel, onAcquire, onReturn }: {
  returning: boolean; busy: boolean; followUp: string; onFollowUp(value: string): void;
  onCancel(): void; onAcquire(): void; onReturn(continueWork: boolean): void;
}): JSX.Element {
  return <div className="remote-control-dialog-backdrop"><div className="remote-inline-confirm" role="dialog" aria-modal="true" aria-label={returning ? "交还远端控制" : "确认手动接管"}>
    <h3>{returning ? "交还控制" : "手动接管"}</h3>
    <p>{returning ? "交还后，空闲时仍可直接操作；智能体工作时恢复只读。可以等待新指令，或让智能体继续。" : "将停止此引擎正在执行的任务。确认停稳后，桌面、浏览器和人工终端一起交给你操作。"}</p>
    {returning && <textarea rows={3} aria-label="交还后的补充要求" placeholder="刚才做了什么，接下来希望怎么继续（可选）" value={followUp} onChange={event => onFollowUp(event.target.value)} />}
    <div><button type="button" className="remote-button" disabled={busy} onClick={onCancel}>取消</button>
      {returning ? <><button type="button" className="remote-button" disabled={busy} onClick={() => onReturn(false)}>交还，等待指令</button><button type="button" className="remote-button remote-button--primary" disabled={busy} onClick={() => onReturn(true)}>交还并继续</button></> : <button type="button" className="remote-button remote-button--primary" disabled={busy} onClick={onAcquire}>{busy ? "正在停止…" : "停止并接管"}</button>}
    </div>
  </div></div>;
}
