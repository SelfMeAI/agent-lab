import type { CSSProperties, JSX } from "react";
import { isAgentRuntimeId } from "../../../../../packages/contracts/src/index";
import { PendingLabPage } from "./shared/PendingLabPage";
import type { LabPageProps } from "./types";
import { LabIcon } from "../shell/LabIcon";

export function LabPage({ lab, viewId, onOpenSettings, providerRevision }: LabPageProps): JSX.Element {
  const Content = lab.Page ?? PendingLabPage;
  if (lab.id === "local-model-lab") return <main className="local-model-lab-page"><Content lab={lab} viewId={viewId} onOpenSettings={onOpenSettings} /></main>;
  if (lab.id === "agent-lab" || lab.id === "jev-lab") return <main className={lab.id === "jev-lab" ? `jev-lab-page${viewId === "xiangqi" ? " jev-lab-page--workspace" : viewId ? " jev-lab-page--experiment" : ""}` : `agent-lab-page${isAgentRuntimeId(viewId) ? " agent-lab-page--workspace" : ""}`}><Content lab={lab} viewId={viewId} onOpenSettings={onOpenSettings} providerRevision={providerRevision} /></main>;
  return (
    <main className="lab-content" style={{ "--accent": lab.accent } as CSSProperties}>
      <div className="lab-heading">
        <LabIcon className="lab-heading__symbol" labId={lab.id} />
        <div>
          <p className="eyebrow">{lab.id === "founder-studio" ? "SELFME LAB / BUSINESS OVERVIEW" : "SELFME LAB / EXPERIMENT"}</p>
          <h1>{lab.title}</h1>
        </div>
      </div>
      <Content lab={lab} viewId={viewId} />
    </main>
  );
}
