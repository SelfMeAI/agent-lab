import type { LabModule } from "../types";
import { RemoteAgentPage } from "./RemoteAgentPage";

export const remoteAgentLab: LabModule = {
  id: "remote-agent-lab",
  title: "REMOTE AGENT LAB",
  group: "runtimes",
  accent: "#39dce3",
  symbol: "≋",
  Page: RemoteAgentPage,
  purpose: "体验自部署的远端智能体，观察执行现场、预览产物，并按各自能力进行人工接管。",
  views: [
    { id: "openhands", label: "OpenHands", designId: "remote.openhands.workspace", designStatus: "approved" },
    { id: "openclaw", label: "OpenClaw", designId: "remote.openclaw.workspace", designStatus: "approved" },
  ],
};
