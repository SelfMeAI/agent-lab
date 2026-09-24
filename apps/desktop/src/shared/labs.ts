import type { LabDefinition, LabId } from "../../../../packages/contracts/src/index";

export const labs: readonly LabDefinition[] = [
  {
    id: "agent-lab",
    title: "AGENT LAB",
    group: "runtimes",
    accent: "#c9ed65",
    symbol: "◎",
    views: [
      { id: "codex", label: "Codex", designId: "agent.codex.workspace" },
      { id: "dsh", label: "DSH", designId: "agent.dsh.workspace" },
      { id: "pi", label: "Pi", designId: "agent.pi.workspace" },
      { id: "kimi-code", label: "Kimi Code", designId: "agent.kimi-code.workspace" },
      { id: "qwen-code", label: "Qwen Code", designId: "agent.qwen-code.workspace" },
      { id: "claude-code", label: "Claude Code", designId: "agent.claude-code.workspace" },
    ],
  },
  {
    id: "remote-agent-lab",
    title: "REMOTE AGENT LAB",
    group: "runtimes",
    accent: "#39dce3",
    symbol: "≋",
    views: [{ id: "openhands", label: "OpenHands", designId: "remote.openhands.run" }],
  },
  {
    id: "local-model-lab",
    title: "LOCAL MODEL LAB",
    group: "runtimes",
    accent: "#cfed72",
    symbol: "⬡",
    views: [
      { id: "playground", label: "Playground", designId: "local-model.ollama.playground" },
      { id: "compare", label: "Compare", designId: "local-model.ollama.compare" },
    ],
  },
  {
    id: "jev-lab",
    title: "JEV LAB",
    group: "engines",
    accent: "#c88de4",
    symbol: "♧",
    views: [{ id: "xiangqi", label: "Xiangqi", designId: "jev.xiangqi.workspace" }],
  },
  {
    id: "harness-forge",
    title: "HARNESS FORGE",
    group: "engines",
    accent: "#f5b746",
    symbol: "</>",
    views: [
      { id: "design", label: "Design", designId: "forge.design" },
      { id: "run", label: "Run", designId: "forge.run" },
      { id: "compare", label: "Compare", designId: "forge.compare" },
    ],
  },
  {
    id: "rsi-lab",
    title: "RSI LAB",
    group: "engines",
    accent: "#85bcfa",
    symbol: "↻",
    views: [
      { id: "overview", label: "Overview", designId: "rsi.overview" },
      { id: "observe", label: "Observe", designId: "rsi.observe" },
      { id: "hypothesize", label: "Hypothesize", designId: "rsi.hypothesize" },
      { id: "modify", label: "Modify", designId: "rsi.modify" },
      { id: "sandbox", label: "Sandbox", designId: "rsi.sandbox" },
      { id: "evaluate", label: "Evaluate", designId: "rsi.evaluate" },
      { id: "promote", label: "Promote", designId: "rsi.promote" },
    ],
  },
  {
    id: "founder-studio",
    title: "FOUNDER STUDIO",
    group: "studio",
    accent: "#f47770",
    symbol: "↗",
    views: [{ id: "overview", label: "Overview", designId: "founder.overview" }],
  },
];

export function labById(id: string): LabDefinition | undefined {
  return labs.find((lab) => lab.id === (id as LabId));
}
