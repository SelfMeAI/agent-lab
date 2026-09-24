import type { CSSProperties, JSX } from "react";
import { goToLab } from "../app/navigation";
import { labGroups, labs } from "../labs/registry";

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
                <span className="lab-card__symbol" aria-hidden="true">{lab.symbol}</span>
                <span className="lab-card__title">{lab.title}</span>
                <span className="lab-card__arrow" aria-hidden="true">⟶</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
