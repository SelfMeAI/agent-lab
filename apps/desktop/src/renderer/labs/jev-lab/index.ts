import type { LabModule } from "../types";
import { JevLabPage } from "./Page";

export const jevLab: LabModule = {
  id: "jev-lab",
  title: "JEV LAB",
  accent: "#c88de4",
  symbol: "♧",
  purpose: "观察 JEV 在具体测试项中的决策过程。",
  views: [
    { id: "agent-review", label: "Agent Review" },
    { id: "customer-action", label: "Customer Action" },
    { id: "invoice-routing", label: "Invoice Routing" },
    { id: "xiangqi", label: "Xiangqi" },
  ],
  Page: JevLabPage,
};
