import type { LabModule } from "../types";
import { JevLabPage } from "./Page";

export const jevLab: LabModule = {
  id: "jev-lab",
  title: "JEV LAB",
  group: "engines",
  accent: "#c88de4",
  symbol: "♧",
  purpose: "观察 JEV 在具体测试项中的决策过程。",
  views: [
    { id: "agent-review", label: "Agent Review", designId: "jev.experiments.workbench" },
    { id: "customer-action", label: "Customer Action", designId: "jev.experiments.workbench" },
    { id: "invoice-routing", label: "Invoice Routing", designId: "jev.experiments.workbench" },
    { id: "xiangqi", label: "Xiangqi", designId: "jev.xiangqi.workspace" },
  ],
  Page: JevLabPage,
};
