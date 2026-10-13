import type { LabModule } from "../types";
import { LocalModelPage } from "./Page";

export const localModelLab: LabModule = {
  id: "local-model-lab",
  title: "LOCAL MODEL LAB",
  accent: "#c7d1de",
  symbol: "⬡",
  purpose: "通过 Ollama 测试和对照本地开源模型。",
  Page: LocalModelPage,
  views: [
    { id: "playground", label: "Playground", designId: "local-model.ollama.playground" },
    { id: "compare", label: "Compare", designId: "local-model.ollama.compare" },
  ],
};
