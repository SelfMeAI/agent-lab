import type { CSSProperties, JSX } from "react";
import type { LabId } from "../../../../../packages/contracts/src/index";
import { goToLab } from "../app/navigation";
import { labs } from "../labs/registry";
import { LabIcon } from "./LabIcon";
import { LabIndexHeader } from "./LabIndexHeader";

const homeSubtitles: Record<LabId, string> = {
  "agent-lab": "本地 Harness 实验",
  "remote-agent-lab": "远程 Agent 实验",
  "local-model-lab": "本地模型实验",
  "jev-lab": "决策模型实验",
};

export function HomePage(): JSX.Element {
  return (
    <main className="home-content lab-index-layout">
      <LabIndexHeader title="LAB INDEX" />
      <section className="lab-grid" aria-label="实验室">
        {labs.map((lab) => (
          <button
            className="lab-card"
            data-lab-id={lab.id}
            key={lab.id}
            onClick={() => goToLab(lab.id)}
            style={{ "--accent": lab.accent } as CSSProperties}
            type="button"
          >
            <LabIcon className="lab-card__symbol" labId={lab.id} />
            <span className="lab-card__copy"><strong>{lab.title}</strong><small>{homeSubtitles[lab.id]}</small></span>
            <svg className="lab-card__arrow" viewBox="0 0 48 32" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M2 16h42m-13-13 13 13-13 13" /></svg>
          </button>
        ))}
      </section>
    </main>
  );
}
