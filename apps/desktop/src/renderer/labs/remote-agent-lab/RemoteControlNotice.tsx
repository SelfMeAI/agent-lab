import type { JSX } from "react";

export function RemoteLockMark(): JSX.Element {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="4.5" y="8.5" width="11" height="8" rx="2" /><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5M10 12v1.5" strokeLinecap="round" /></svg>;
}

export function RemoteControlNotice({ onHandback }: { onHandback(): void }): JSX.Element {
  return <div className="remote-control-banner">
    <span className="remote-control-banner__mark"><RemoteLockMark /></span>
    <div className="remote-control-banner__text" role="status">
      <strong>你正在接管远端现场</strong>
      <span>智能体操作已暂停 · 交还后可切换任务和发送消息</span>
    </div>
    <button type="button" className="remote-button remote-control-return" onClick={onHandback}>交还控制 <span aria-hidden="true">↗</span></button>
  </div>;
}
