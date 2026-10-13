import type { LabModule } from "../types";
import { RemoteAgentPage } from "./RemoteAgentPage";

export const remoteAgentLab: LabModule = {
  id: "remote-agent-lab",
  title: "REMOTE AGENT LAB",
  accent: "#39dce3",
  symbol: "≋",
  Page: RemoteAgentPage,
  purpose: "体验自部署的远端智能体，查看任务过程、远端工作区与文件产物。",
  views: [
    { id: "openhands", label: "OpenHands" },
    { id: "openclaw", label: "OpenClaw" },
  ],
};
