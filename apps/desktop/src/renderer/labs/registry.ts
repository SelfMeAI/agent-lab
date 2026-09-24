import type { LabGroup } from "../../../../../packages/contracts/src/index";
import { agentLab } from "./agent-lab";
import { founderStudio } from "./founder-studio";
import { harnessForge } from "./harness-forge";
import { jevLab } from "./jev-lab";
import { localModelLab } from "./local-model-lab";
import { remoteAgentLab } from "./remote-agent-lab";
import { rsiLab } from "./rsi-lab";
import type { LabModule } from "./types";

export const labGroups: readonly { id: LabGroup; title: string }[] = [
  { id: "runtimes", title: "RUNTIMES" },
  { id: "engines", title: "ENGINES" },
  { id: "studio", title: "STUDIO" },
];

export const labs: readonly LabModule[] = [
  agentLab,
  remoteAgentLab,
  localModelLab,
  jevLab,
  harnessForge,
  rsiLab,
  founderStudio,
];

export function labById(id: string): LabModule | undefined {
  return labs.find((lab) => lab.id === id);
}
