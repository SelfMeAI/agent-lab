import type { LabModule } from "../types";

export const remoteAgentLab: LabModule = {
  id: "remote-agent-lab",
  title: "REMOTE AGENT LAB",
  group: "runtimes",
  accent: "#39dce3",
  symbol: "≋",
  purpose: "连接自部署的远端 Agent，查看运行与变更。",
  views: [{ id: "openhands", label: "OpenHands", designId: "remote.openhands.run" }],
};
