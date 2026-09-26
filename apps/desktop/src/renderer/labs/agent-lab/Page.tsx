import { useEffect, useState, type CSSProperties, type JSX } from "react";
import type { RuntimeStatus } from "../../../../../../packages/contracts/src/index";
import { goToLab } from "../../app/navigation";
import { LabIcon } from "../../shell/LabIcon";
import { PendingLabPage } from "../shared/PendingLabPage";
import type { LabPageProps } from "../types";
import { AgentWorkspace } from "./AgentWorkspace";
import "./agent-lab.css";

const accents: Record<string, string> = {
  dsh: "#d3fb52", codex: "#40dbe7", pi: "#b9ddf0", "kimi-code": "#f38f8e",
  "qwen-code": "#91c4b9", "claude-code": "#bd8df7",
};
const descriptions: Record<string, string> = {
  dsh: "本地任务与工具调用",
  codex: "本地编程与工作区",
  pi: "轻量 Agent 实验",
  "kimi-code": "代码任务与工具实验",
  "qwen-code": "代码任务与工具实验",
  "claude-code": "外部编程助手实验",
};

export function AgentLabPage({ lab, viewId, onOpenSettings, providerRevision }: LabPageProps): JSX.Element {
  const [runtimeStatuses, setRuntimeStatuses] = useState<RuntimeStatus[]>([]);
  useEffect(() => {
    if (window.selfmeLab) void window.selfmeLab.listRuntimes().then(setRuntimeStatuses).catch(() => setRuntimeStatuses([]));
  }, []);

  if (!viewId) {
    return (
      <section className="agent-index">
        <h1>AGENT LAB</h1>
        <div className="agent-index__group"><h2>HARNESS RUNTIMES</h2><span /></div>
        <div className="agent-grid">
          {lab.views.map((item) => {
            const status = runtimeStatuses.find((entry) => entry.id === item.id);
            const label = status?.availability === "ready" ? "READY" : status?.availability === "missing" ? "SETUP" : item.id === "claude-code" ? "EXTERNAL" : "PLANNED";
            return <button className="agent-tile" key={item.id} onClick={() => goToLab(lab.id, item.id)} style={{ "--tile-accent": accents[item.id] } as CSSProperties} type="button">
              <LabIcon runtimeId={item.id} className="agent-tile__icon" />
              <span className="agent-tile__text"><strong>{item.label.toUpperCase()}</strong><small>{descriptions[item.id] ?? "Harness 接入实验"}</small><em>{label}</em></span>
              <svg className="agent-tile__arrow" viewBox="0 0 48 32" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M2 16h42m-13-13 13 13-13 13" /></svg>
            </button>;
          })}
        </div>
      </section>
    );
  }

  if (viewId === "dsh" || viewId === "codex" || viewId === "pi" || viewId === "kimi-code" || viewId === "qwen-code") return <AgentWorkspace runtimeId={viewId} onOpenSettings={onOpenSettings} providerRevision={providerRevision} />;

  return (
    <div className="agent-pending">
      <div className="agent-pending__heading"><LabIcon runtimeId={viewId} /><h1>{lab.views.find((item) => item.id === viewId)?.label.toUpperCase()} LAB</h1></div>
      <PendingLabPage lab={lab} viewId={viewId} />
    </div>
  );
}
