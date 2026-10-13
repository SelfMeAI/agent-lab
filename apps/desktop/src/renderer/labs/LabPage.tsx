import type { CSSProperties, JSX } from "react";
import { isAgentRuntimeId } from "../../../../../packages/contracts/src/index";
import type { LabPageProps } from "./types";

export function LabPage({ lab, viewId, onOpenSettings, providerRevision }: LabPageProps): JSX.Element {
  const Content = lab.Page;
  if (!viewId && lab.id !== "local-model-lab") return <main className="lab-index-page"><Content lab={lab} onOpenSettings={onOpenSettings} providerRevision={providerRevision} /></main>;
  if (lab.id === "remote-agent-lab") return <main className="remote-lab-page"><Content lab={lab} viewId={viewId} /></main>;
  if (lab.id === "local-model-lab") return <main className="local-model-lab-page" style={{ "--accent": lab.accent } as CSSProperties}><Content lab={lab} viewId={viewId} onOpenSettings={onOpenSettings} /></main>;
  return <main className={lab.id === "jev-lab" ? `jev-lab-page${viewId === "xiangqi" ? " jev-lab-page--workspace" : viewId ? " jev-lab-page--experiment" : ""}` : `agent-lab-page${isAgentRuntimeId(viewId) ? " agent-lab-page--workspace" : ""}`}><Content lab={lab} viewId={viewId} onOpenSettings={onOpenSettings} providerRevision={providerRevision} /></main>;
}
