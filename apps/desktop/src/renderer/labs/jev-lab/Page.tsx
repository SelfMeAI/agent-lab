import type { JSX } from "react";
import { goToLab } from "../../app/navigation";
import { LabIcon } from "../../shell/LabIcon";
import type { LabPageProps } from "../types";
import { XiangqiWorkspace } from "./XiangqiWorkspace";
import "./jev-lab.css";

export function JevLabPage({ lab, viewId, onOpenSettings, providerRevision }: LabPageProps): JSX.Element {
  if (viewId === "xiangqi") return <XiangqiWorkspace onOpenSettings={onOpenSettings} providerRevision={providerRevision} />;
  return <section className="jev-index"><div className="jev-index__heading"><LabIcon labId="jev-lab" /><h1>JEV LAB</h1></div><p>决策模型实验 / 测试项</p><button type="button" onClick={() => goToLab(lab.id, "xiangqi")}>XIANGQI <span>进入象棋观测台 →</span></button></section>;
}
