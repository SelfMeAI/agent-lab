import { agentLab } from "./agent-lab";
import { jevLab } from "./jev-lab";
import { localModelLab } from "./local-model-lab";
import { remoteAgentLab } from "./remote-agent-lab";
import type { LabModule } from "./types";

export const labs: readonly LabModule[] = [
  agentLab,
  remoteAgentLab,
  localModelLab,
  jevLab,
];

export function labById(id: string): LabModule | undefined {
  return labs.find((lab) => lab.id === id);
}
