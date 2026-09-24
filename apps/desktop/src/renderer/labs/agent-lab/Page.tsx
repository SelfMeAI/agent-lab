import { useState, type JSX } from "react";
import { goToLab } from "../../app/navigation";
import { PendingLabPage } from "../shared/PendingLabPage";
import type { LabPageProps } from "../types";
import "./agent-lab.css";

export function AgentLabPage({ lab, viewId }: LabPageProps): JSX.Element {
  const [workspace, setWorkspace] = useState<string | null>(null);

  async function selectWorkspace(): Promise<void> {
    if (!window.selfmeLab) return;
    const selected = await window.selfmeLab.chooseWorkspace();
    if (selected) setWorkspace(selected);
  }

  if (!viewId) {
    return (
      <section className="agent-index">
        <div className="section-title"><h2>LOCAL HARNESSES</h2><span>独立实验入口</span></div>
        <div className="agent-grid">
          {lab.views.map((item) => (
            <button className="agent-tile" key={item.id} onClick={() => goToLab(lab.id, item.id)} type="button">
              <span>{item.label}</span><span aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <PendingLabPage lab={lab} viewId={viewId}>
      <div className="workspace-control">
        <button onClick={() => void selectWorkspace()} type="button">选择工作目录 ↗</button>
        <span title={workspace ?? undefined}>{workspace ?? "尚未选择工作目录"}</span>
      </div>
    </PendingLabPage>
  );
}
