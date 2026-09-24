import type { LabModule } from "../types";

export const harnessForge: LabModule = {
  id: "harness-forge",
  title: "HARNESS FORGE",
  group: "engines",
  accent: "#f5b746",
  symbol: "</>",
  purpose: "设计、运行和对照我们自己的 Harness。",
  views: [
    { id: "design", label: "Design", designId: "forge.design" },
    { id: "run", label: "Run", designId: "forge.run" },
    { id: "compare", label: "Compare", designId: "forge.compare" },
  ],
};
