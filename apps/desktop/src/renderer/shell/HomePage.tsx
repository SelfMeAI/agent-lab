import type { CSSProperties, JSX } from "react";
import type { LabId } from "../../../../../packages/contracts/src/index";
import { goToAtlas, goToLab } from "../app/navigation";
import { labGroups, labs } from "../labs/registry";
import { LabIcon } from "./LabIcon";

const homeSubtitles: Record<LabId, string> = {
  "agent-lab": "本地 Harness 实验",
  "remote-agent-lab": "远程 Agent 实验",
  "local-model-lab": "本地模型实验",
  "jev-lab": "决策模型实验",
  "harness-forge": "自研 Harness 实验",
  "rsi-lab": "Harness 自我改进",
  "founder-studio": "业务方向与想法验证",
};

export function HomePage(): JSX.Element {
  return (
    <main className="home-content">
      <h1 className="page-title">LAB INDEX</h1>
      <section className="lab-group home-overviews" aria-label="OVERVIEWS">
        <div className="group-heading"><h2>OVERVIEWS</h2><span /></div>
        <div className="home-overview-grid">
          <button className="home-overview-card" type="button" onClick={goToAtlas}>
            <span className="home-overview-card__mark home-overview-card__mark--atlas" aria-hidden="true"><i /><i /><i /><i /><b>✳</b></span>
            <span className="home-overview-card__copy"><strong>AGENT ATLAS</strong><small>技术能力与体验全景</small></span>
            <span className="home-overview-card__arrow" aria-hidden="true">↗</span>
          </button>
          <button className="home-overview-card home-overview-card--founder" type="button" onClick={() => goToLab("founder-studio")}>
            <LabIcon className="home-overview-card__icon" labId="founder-studio" />
            <span className="home-overview-card__copy"><strong>FOUNDER STUDIO</strong><small>{homeSubtitles["founder-studio"]}</small></span>
            <span className="home-overview-card__arrow" aria-hidden="true">↗</span>
          </button>
        </div>
      </section>
      {labGroups.map((group) => (
        <section className="lab-group" key={group.id} aria-label={group.title}>
          <div className="group-heading"><h2>{group.title}</h2><span /></div>
          <div className={`lab-grid lab-grid--${group.id}`}>
            {labs.filter((lab) => lab.group === group.id).map((lab) => (
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
          </div>
        </section>
      ))}
    </main>
  );
}
