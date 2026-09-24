import type { JSX, ReactNode } from "react";
import { goToLab } from "../../app/navigation";
import type { LabPageProps } from "../types";

interface PendingLabPageProps extends LabPageProps {
  children?: ReactNode;
}

export function PendingLabPage({ lab, viewId, children }: PendingLabPageProps): JSX.Element {
  const view = lab.views.find((item) => item.id === viewId) ?? lab.views[0];
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
          <span>DESIGN APPROVED / INTEGRATION PENDING</span>
        </div>
        <div className="module-frame__body">
          <p className="module-kicker">FRAMEWORK READY</p>
          <h2>这个实验尚未接入运行时</h2>
          <p>{lab.purpose}</p>
          <p className="module-note">当前界面只确认模块、导航与桌面边界。接入并验收真实运行后，才会显示对话、指标或产物。</p>
          {children}
        </div>
      </section>
    </>
  );
}
