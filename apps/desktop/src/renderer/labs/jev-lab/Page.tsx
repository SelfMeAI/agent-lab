import type { JSX } from "react";
import { isJevExperimentId, jevExperimentIds, jevExperiments } from "../../../jev-experiments/catalog";
import { goToLab } from "../../app/navigation";
import { LabIcon } from "../../shell/LabIcon";
import type { LabPageProps } from "../types";
import { ExperimentWorkbench } from "./ExperimentWorkbench";
import { XiangqiWorkspace } from "./XiangqiWorkspace";
import "./jev-lab.css";

export function JevLabPage({ lab, viewId, onOpenSettings, providerRevision }: LabPageProps): JSX.Element {
  if (viewId === "xiangqi") return <XiangqiWorkspace onOpenSettings={onOpenSettings} providerRevision={providerRevision} />;
  if (isJevExperimentId(viewId)) return <ExperimentWorkbench key={viewId} experimentId={viewId} onOpenSettings={onOpenSettings} providerRevision={providerRevision} />;
  return <section className="jev-index">
    <div className="jev-index__heading"><LabIcon labId="jev-lab" /><h1>JEV LAB</h1></div>
    <p>独立实验项目 · 比较 JEV 在不同决策场景中的真实表现</p>
    <div className="jev-index__grid">
      {jevExperimentIds.map((id) => <button key={id} type="button" onClick={() => goToLab(lab.id, id)}><strong>{jevExperiments[id].shortTitle}</strong><span>{jevExperiments[id].title} · 4 个预设案例</span><em>进入实验 →</em></button>)}
      <button type="button" onClick={() => goToLab(lab.id, "xiangqi")}><strong>XIANGQI</strong><span>象棋 · 连续决策与高数量候选测试</span><em>进入观测台 →</em></button>
    </div>
  </section>;
}
