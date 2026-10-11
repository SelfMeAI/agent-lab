import { useEffect, useRef, useState, type JSX } from "react";
import type { RemoteDesktopGrant, RemoteSceneAccess } from "../../../../../../packages/contracts/src/remote-agent";
import { remoteError } from "./service-presentation";

/** One control lease for all views. A tab switch is never an acquire/release. */
export function sceneInputEnabled(scene: RemoteSceneAccess | undefined, connected: boolean, busy: boolean, dialog: boolean, resource: "desktop" | "browser" | "terminal" = "desktop"): boolean {
  const allowed = resource === "browser" ? scene?.browserInputAllowed : resource === "terminal" ? scene?.terminalInputAllowed : scene?.inputAllowed;
  return connected && allowed === true && !busy && !dialog;
}
export function sceneControlLabel(scene: RemoteSceneAccess | undefined): string {
  if (!scene) return "正在同步现场…";
  if (scene.takeover === "waiting") return "等待智能体完成当前操作";
  if (scene.takeover === "stopping") return "正在停止智能体的当前操作";
  if (scene.humanControl) return "已接管 · 可操作";
  if (scene.agentBusy) return "智能体工作中";
  return scene.inputAllowed ? "空闲 · 可操作" : "现场暂不可操作";
}
export function useSceneControl(taskId: string, enabled: boolean, snapshotAccess: RemoteSceneAccess | undefined, returning: boolean, onReturningChange: (value: boolean) => void) {
  const [grant, setGrant] = useState<RemoteDesktopGrant>();
  const [scene, setScene] = useState<RemoteSceneAccess>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [followUp, setFollowUp] = useState("");
  const alive = useRef(false), lock = useRef(false), version = useRef(0);
  const grantRef = useRef(grant); grantRef.current = grant;
  useEffect(() => {
    alive.current = true; const ticket = ++version.current;
    setGrant(undefined); setScene(undefined); setError(""); setBusy(false); setFollowUp(""); lock.current = false;
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
  async function observe(control: boolean, force = false): Promise<void> {
    if (!enabled || lock.current) return;
    const ticket = ++version.current; lock.current = true; setBusy(true); setError("");
    try {
      const value = await window.selfmeLab!.observeRemoteDesktop("openclaw", taskId, control, force);
      if (alive.current && ticket === version.current) { setGrant(value); setScene(value.scene); }
    } catch (cause) { if (alive.current && ticket === version.current) setError(remoteError(cause)); }
    finally { if (alive.current && ticket === version.current) { lock.current = false; setBusy(false); } }
  }
  async function handBack(): Promise<void> {
    if (!enabled || lock.current) return;
    const ticket = ++version.current; lock.current = true; setBusy(true); setError("");
    try {
      // Empty handback releases the same pending call, not a new "continue"
      // task. A forced/expired round stays ended until the user sends a message.
      const value = await window.selfmeLab!.returnRemoteDesktop("openclaw", taskId, followUp.trim() || undefined);
      if (alive.current && ticket === version.current) { setGrant(value); setScene(value.scene); onReturningChange(false); setFollowUp(""); }
    } catch (cause) { if (alive.current && ticket === version.current) setError(remoteError(cause)); }
    finally { if (alive.current && ticket === version.current) { lock.current = false; setBusy(false); } }
  }
  const inputEnabled = sceneInputEnabled(scene, grant?.control === true, busy, returning);
  const browserInputEnabled = sceneInputEnabled(scene, enabled, busy, returning, "browser");
  const terminalInputEnabled = sceneInputEnabled(scene, enabled, busy, returning, "terminal");
  return { grant, scene, busy, error, followUp, inputEnabled, browserInputEnabled, terminalInputEnabled, setFollowUp, observe, handBack };
}

export function SceneControlWaiting({ stopping, busy, retry = false, onForce }: { stopping: boolean; busy: boolean; retry?: boolean; onForce(): void }): JSX.Element {
  return <div className="remote-takeover-wait" role="status">
    <span className="remote-spinner" aria-hidden="true" />
    <div><strong>{stopping ? "正在停止智能体的当前操作" : "等待智能体完成当前操作"}</strong>
      <p>{stopping ? "确认停止后交由你控制。" : "智能体不会开始下一步，当前操作结束后自动交由你控制。"}</p></div>
    <button type="button" className="remote-button remote-control-return" disabled={busy || stopping && !retry} title="中止当前操作并接管，当前操作可能尚未完成。" onClick={onForce}>停止并接管</button>
  </div>;
}

export function SceneControlDialog({ busy, followUp, onFollowUp, onCancel, onReturn }: {
  busy: boolean; followUp: string; onFollowUp(value: string): void;
  onCancel(): void; onReturn(): void;
}): JSX.Element {
  return <div className="remote-control-dialog-backdrop"><div className="remote-inline-confirm" role="dialog" aria-modal="true" aria-label="交还远端控制">
    <h3>交还控制</h3>
    <p>交还后，暂停的操作可以继续。如果当前轮已经结束，可以发送新要求。浏览器和人工终端仅在智能体操作对应资源时只读。</p>
    <textarea rows={3} aria-label="交还后的补充要求" placeholder="刚才做了什么，接下来希望怎么继续（可选）" value={followUp} onChange={event => onFollowUp(event.target.value)} />
    <div><button type="button" className="remote-button" disabled={busy} onClick={onCancel}>取消</button>
      <button type="button" className="remote-button remote-button--primary" disabled={busy} onClick={onReturn}>{busy ? "正在交还…" : "交还控制"}</button>
    </div>
  </div></div>;
}
