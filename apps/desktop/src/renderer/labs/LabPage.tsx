import type { CSSProperties, JSX } from "react";
import { PendingLabPage } from "./shared/PendingLabPage";
import type { LabPageProps } from "./types";

export function LabPage({ lab, viewId }: LabPageProps): JSX.Element {
  const Content = lab.Page ?? PendingLabPage;
  return (
    <main className="lab-content" style={{ "--accent": lab.accent } as CSSProperties}>
      <div className="lab-heading">
        <span className="lab-heading__symbol" aria-hidden="true">{lab.symbol}</span>
        <div>
          <p className="eyebrow">SELFME LAB / EXPERIMENT</p>
          <h1>{lab.title}</h1>
        </div>
      </div>
      <Content lab={lab} viewId={viewId} />
    </main>
  );
}
