import type { JSX, ReactNode } from "react";
import { goToLab } from "../../app/navigation";
import type { LabPageProps } from "../types";

interface PendingLabPageProps extends LabPageProps {
  children?: ReactNode;
}

export function PendingLabPage({ lab, viewId, children }: PendingLabPageProps): JSX.Element {
  const view = lab.views.find((item) => item.id === viewId) ?? lab.views[0];
  const businessOverview = lab.id === "founder-studio";
  const designPending = view.designStatus === "pending";
  return (
    <>
      {lab.views.length > 1 && (
        <nav className="lab-tabs" aria-label={`${lab.title} 界面`}>
          {lab.views.map((item) => (
            <button
              className={item.id === view.id ? "is-active" : ""}
              key={item.id}
              onClick={() => goToLab(lab.id, item.id)}
              type="button"
            >{item.label}</button>
          ))}
        </nav>
      )}
      <section className="module-frame">
        <div className="module-frame__topline">
          <span>{view.label.toUpperCase()}</span>
          <span>{designPending ? "CAPABILITY CHECK / DESIGN PENDING" : businessOverview ? "DESIGN APPROVED / WORKFLOW PENDING" : "DESIGN APPROVED / INTEGRATION PENDING"}</span>
        </div>
        <div className="module-frame__body">
          <p className="module-kicker">{designPending ? "REMOTE EXECUTION / VALIDATING" : businessOverview ? "BUSINESS VIEW / PLANNED" : "FRAMEWORK READY"}</p>
          <h2>{designPending ? "正在验证远端执行与现场能力" : businessOverview ? "业务方向工作台尚未开始记录" : "这个实验尚未接入运行时"}</h2>
          <p>{lab.purpose}</p>
          <p className="module-note">{designPending ? "旧远端设计稿已废止。验证各引擎真实能力后分别设计工作台，不以统一交互限制原生能力。" : businessOverview ? "目前只确认业务视角与入口；想法、证据、验证和判断流程尚未实装，不展示虚构统计。" : "当前界面只确认模块、导航与桌面边界。接入并验收真实运行后，才会显示对话、指标或产物。"}</p>
          {children}
        </div>
      </section>
    </>
  );
}
