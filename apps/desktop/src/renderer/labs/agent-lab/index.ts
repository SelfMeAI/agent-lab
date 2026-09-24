import type { LabModule } from "../types";
import { AgentLabPage } from "./Page";

export const agentLab: LabModule = {
  id: "agent-lab",
  title: "AGENT LAB",
  group: "runtimes",
  accent: "#c9ed65",
  symbol: "◎",
  purpose: "独立接入并观察本地 Harness 的真实工作过程。",
  Page: AgentLabPage,
  views: [
    { id: "codex", label: "Codex", designId: "agent.codex.workspace" },
    { id: "dsh", label: "DSH", designId: "agent.dsh.workspace" },
    { id: "pi", label: "Pi", designId: "agent.pi.workspace" },
    { id: "kimi-code", label: "Kimi Code", designId: "agent.kimi-code.workspace" },
    { id: "qwen-code", label: "Qwen Code", designId: "agent.qwen-code.workspace" },
    { id: "claude-code", label: "Claude Code", designId: "agent.claude-code.workspace" },
  ],
};
