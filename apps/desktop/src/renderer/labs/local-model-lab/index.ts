import type { LabModule } from "../types";

export const localModelLab: LabModule = {
  id: "local-model-lab",
  title: "LOCAL MODEL LAB",
  group: "runtimes",
  accent: "#cfed72",
  symbol: "⬡",
  purpose: "通过 Ollama 测试和对照本地开源模型。",
  views: [
    { id: "playground", label: "Playground", designId: "local-model.ollama.playground" },
    { id: "compare", label: "Compare", designId: "local-model.ollama.compare" },
  ],
};
