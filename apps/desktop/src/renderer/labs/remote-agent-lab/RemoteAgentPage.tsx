import { useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { isRemoteAgentId, remoteAgentIds, type RemoteAgentId, type RemoteServiceState } from "../../../../../../packages/contracts/src/remote-agent";
import { goToLab } from "../../app/navigation";
import { LabIcon } from "../../shell/LabIcon";
import type { LabPageProps } from "../types";
import { RemoteServicePanel } from "./RemoteServicePanel";
import { remoteError, remoteServiceLabel } from "./service-presentation";
import "./remote-agent.css";

export const remoteEngines = {
  openhands: { name: "OpenHands", mark: "OH", color: "#39dce3", description: "代码、浏览器与任务执行" },
  openclaw: { name: "OpenClaw", mark: "OC", color: "#f28b7b", description: "桌面、浏览器与任务执行" },
};
export type ServiceStates = Partial<Record<RemoteAgentId, RemoteServiceState>>;
export type ServiceBusy = Partial<Record<RemoteAgentId, boolean>>;

export function RemoteMark({ engine }: { engine: RemoteAgentId }): JSX.Element {
  return <span className="remote-engine-mark" style={{ "--remote-engine": remoteEngines[engine].color } as CSSProperties} aria-hidden="true">{remoteEngines[engine].mark}</span>;
}
export function ServiceStatus({ state }: { state?: RemoteServiceState }): JSX.Element {
  return <span className={`remote-status remote-status--${state?.phase ?? "loading"}`} title={state?.detail} aria-live="polite"><i />{remoteServiceLabel(state)}</span>;
}

export function RemoteAgentPage({ viewId }: LabPageProps): JSX.Element {
  const engine = isRemoteAgentId(viewId) ? viewId : undefined;
  const [states, setStates] = useState<ServiceStates>({});
  const [busy, setBusy] = useState<ServiceBusy>({});
  const [errors, setErrors] = useState<Partial<Record<RemoteAgentId, string>>>({});
  const [panel, setPanel] = useState(false);
  const alive = useRef(true);
  const actionLocks = useRef(new Set<RemoteAgentId>());

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(): Promise<void> {
      const bridge = window.selfmeLab;
      if (bridge) await Promise.all(remoteAgentIds.map(async id => {
        try {
          const state = await bridge.getRemoteServiceState(id);
          if (alive.current) setStates(previous => ({ ...previous, [id]: state }));
        } catch (cause) { if (alive.current) setErrors(previous => ({ ...previous, [id]: remoteError(cause) })); }
      }));
      if (alive.current) timer = setTimeout(() => void refresh(), 6000);
    }
    void refresh();
    return () => { alive.current = false; clearTimeout(timer); };
  }, []);

  async function control(id: RemoteAgentId, action: "start" | "stop" | "restart"): Promise<void> {
    if (!window.selfmeLab || actionLocks.current.has(id)) return;
    actionLocks.current.add(id); setBusy(previous => ({ ...previous, [id]: true })); setErrors(previous => ({ ...previous, [id]: "" }));
    try {
      const state = await window.selfmeLab.controlRemoteService(id, action);
      if (alive.current) setStates(previous => ({ ...previous, [id]: state }));
    } catch (cause) {
      if (alive.current) setErrors(previous => ({ ...previous, [id]: remoteError(cause) }));
      try { const state = await window.selfmeLab.getRemoteServiceState(id); if (alive.current) setStates(previous => ({ ...previous, [id]: state })); } catch { /* primary error visible */ }
    } finally {
      actionLocks.current.delete(id);
      if (alive.current) setBusy(previous => ({ ...previous, [id]: false }));
    }
  }

  return <div className={`remote-page${engine ? " remote-page--workspace" : ""}`}>
    <header className="remote-heading">
      <LabIcon labId="remote-agent-lab" className="remote-heading__icon" />
      <div className="remote-heading__copy"><h1>REMOTE AGENT LAB</h1>{!engine && <p>远端智能体实验室</p>}</div>
      {engine && <span className={`remote-heading__engine remote-heading__engine--${engine}`}>{remoteEngines[engine].name}</span>}
      <button className="remote-button remote-service-entry" type="button" onClick={() => setPanel(true)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m12 3 2 3 3.5-.2.2 3.5 3 2-3 2-.2 3.5-3.5-.2-2 3-2-3-3.5.2-.2-3.5-3-2 3-2 .2-3.5 3.5.2Z" /><circle cx="12" cy="12" r="3" /></svg>
        {engine ? `服务 · ${states[engine]?.phase === "ready" ? "已连接" : "未连接"}` : "服务管理"}
      </button>
    </header>
    {!engine ? <>
      <section className="remote-engine-grid" aria-label="选择远端智能体">
        {remoteAgentIds.map(id => <button key={id} type="button" className="remote-engine-card" style={{ "--remote-engine": remoteEngines[id].color } as CSSProperties} onClick={() => goToLab("remote-agent-lab", id)}>
          <RemoteMark engine={id} />
          <span className="remote-engine-card__copy"><strong>{remoteEngines[id].name}</strong><span>{remoteEngines[id].description}</span><ServiceStatus state={states[id]} /></span>
          <svg className="remote-engine-card__arrow" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 16h26M17 5l11 11-11 11" /></svg>
        </button>)}
      </section>
      <footer className="remote-index-note"><span>ⓘ</span>任务在远端执行，文件通过上传和下载交换</footer>
    </> : <section className="remote-connection-stage" aria-label={`${remoteEngines[engine].name} 服务接入`}>
      <RemoteMark engine={engine} />
      <h2>{remoteEngines[engine].name}</h2>
      <ServiceStatus state={states[engine]} />
      <p>{states[engine]?.phase === "ready" ? "服务连接已打通，任务通信和执行现场将在下一步接入。" : "先启动远端服务，再配置模型连接。任务与文件将留在服务端。"}</p>
      <button type="button" className="remote-button" onClick={() => setPanel(true)}>打开服务管理</button>
      {errors[engine] && <p className="remote-error" role="alert">{errors[engine]}</p>}
    </section>}
    {panel && <RemoteServicePanel initialEngine={engine ?? "openhands"} states={states} busy={busy} errors={errors} onControl={control} onClose={() => setPanel(false)} />}
  </div>;
}
