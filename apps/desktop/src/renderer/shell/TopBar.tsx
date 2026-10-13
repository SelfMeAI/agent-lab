import type { JSX } from "react";
import { goHome } from "../app/navigation";
import brandMark from "../../../../../assets/brand/agent-lab-mark.png";

interface TopBarProps {
  inLab: boolean;
  showSettings: boolean;
  onBack(): void;
  onOpenSettings(): void;
}

export function TopBar({ inLab, showSettings, onBack, onOpenSettings }: TopBarProps): JSX.Element {
  return (
    <header className="topbar">
      <button className="brand" onClick={goHome} type="button" aria-label="返回 Agent Lab 首页">
        <img src={brandMark} alt="" /><span>AGENT LAB</span>
      </button>
      <div className="topbar-actions">
        {inLab && <button className="icon-button" onClick={onBack} type="button" aria-label="返回上一级"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M27 16H5m10-10L5 16l10 10" /></svg></button>}
        {showSettings && <button className="icon-button" onClick={onOpenSettings} type="button" aria-label="设置"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 7h24M4 16h24M4 25h24" /><circle cx="12" cy="7" r="3" fill="#071013" /><circle cx="22" cy="16" r="3" fill="#071013" /><circle cx="15" cy="25" r="3" fill="#071013" /></svg></button>}
      </div>
    </header>
  );
}
