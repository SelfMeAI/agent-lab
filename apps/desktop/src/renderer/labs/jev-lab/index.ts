import type { LabModule } from "../types";
import { JevLabPage } from "./Page";

export const jevLab: LabModule = {
  id: "jev-lab",
  title: "JEV LAB",
  group: "engines",
  accent: "#c88de4",
  symbol: "♧",
  purpose: "观察 JEV 在具体测试项中的决策过程。",
  views: [{ id: "xiangqi", label: "Xiangqi", designId: "jev.xiangqi.workspace" }],
  Page: JevLabPage,
};
