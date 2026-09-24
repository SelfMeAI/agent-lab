import type { CSSProperties, JSX } from "react";
import { goToLab } from "../app/navigation";
import { labGroups, labs } from "../labs/registry";
import { LabIcon } from "./LabIcon";

export function HomePage(): JSX.Element {
  return (
    <main className="home-content">
      <h1 className="page-title">LAB INDEX</h1>
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
                <span className="lab-card__title">{lab.title}</span>
                <svg className="lab-card__arrow" viewBox="0 0 48 32" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M2 16h42m-13-13 13 13-13 13" /></svg>
              </button>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
