import type { LabModule } from "../types";
import { AgentLabPage } from "./Page";

export const agentLab: LabModule = {
  id: "agent-lab",
  title: "AGENT LAB",
  accent: "#c9ed65",
  symbol: "◎",
  purpose: "独立接入并观察本地 Harness 的真实工作过程。",
  Page: AgentLabPage,
  views: [
    { id: "dsh", label: "DSH" },
    { id: "codex", label: "Codex" },
    { id: "pi", label: "Pi" },
    { id: "kimi-code", label: "Kimi Code" },
    { id: "qwen-code", label: "Qwen Code" },
    { id: "claude-code", label: "Claude Agent" },
  ],
};
