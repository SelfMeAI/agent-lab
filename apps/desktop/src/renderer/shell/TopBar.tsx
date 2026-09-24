import type { JSX } from "react";
import { goHome } from "../app/navigation";
import brandMark from "../../../../../assets/brand/selfme-lab-mark.png";

interface TopBarProps {
  inLab: boolean;
  onOpenSettings(): void;
}

export function TopBar({ inLab, onOpenSettings }: TopBarProps): JSX.Element {
  return (
    <header className="topbar">
      <button className="brand" onClick={goHome} type="button" aria-label="返回 SelfMe Lab 首页">
        <img src={brandMark} alt="" /><span>SELFME LAB</span>
      </button>
      <div className="topbar-actions">
        {inLab && <button className="icon-button" onClick={goHome} type="button" aria-label="返回首页">←</button>}
        <button className="icon-button" onClick={onOpenSettings} type="button" aria-label="设置">☷</button>
      </div>
    </header>
  );
}
