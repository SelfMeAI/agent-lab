import type { LabModule } from "../types";

export const rsiLab: LabModule = {
  id: "rsi-lab",
  title: "RSI LAB",
  group: "engines",
  accent: "#85bcfa",
  symbol: "↻",
  purpose: "在隔离与人工批准下验证 Harness 的自我改进循环。",
  views: [
    { id: "overview", label: "Overview", designId: "rsi.overview" },
    { id: "observe", label: "Observe", designId: "rsi.observe" },
    { id: "hypothesize", label: "Hypothesize", designId: "rsi.hypothesize" },
    { id: "modify", label: "Modify", designId: "rsi.modify" },
    { id: "sandbox", label: "Sandbox", designId: "rsi.sandbox" },
    { id: "evaluate", label: "Evaluate", designId: "rsi.evaluate" },
    { id: "promote", label: "Promote", designId: "rsi.promote" },
  ],
};
