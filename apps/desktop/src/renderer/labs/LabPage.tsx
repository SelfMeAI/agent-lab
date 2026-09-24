import type { CSSProperties, JSX } from "react";
import { PendingLabPage } from "./shared/PendingLabPage";
import type { LabPageProps } from "./types";
import { LabIcon } from "../shell/LabIcon";

export function LabPage({ lab, viewId, onOpenSettings, providerRevision }: LabPageProps): JSX.Element {
  const Content = lab.Page ?? PendingLabPage;
  if (lab.id === "agent-lab") return <main className="agent-lab-page"><Content lab={lab} viewId={viewId} onOpenSettings={onOpenSettings} providerRevision={providerRevision} /></main>;
  return (
    <main className="lab-content" style={{ "--accent": lab.accent } as CSSProperties}>
      <div className="lab-heading">
        <LabIcon className="lab-heading__symbol" labId={lab.id} />
        <div>
          <p className="eyebrow">SELFME LAB / EXPERIMENT</p>
          <h1>{lab.title}</h1>
        </div>
      </div>
      <Content lab={lab} viewId={viewId} />
    </main>
  );
}
