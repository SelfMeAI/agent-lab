import type { JSX } from "react";
import type { RemoteTaskStatus } from "../../../../../../packages/contracts/src/remote-agent";
import { remoteTaskLabels } from "./task-presentation";

export function RemoteExecutionStatus({ status, opening }: { status?: RemoteTaskStatus; opening: boolean }): JSX.Element | null {
  if (!opening && !status) return null;
  const loading = opening || status === "running";
  return <div className="remote-composer__status" role="status" aria-live="polite" aria-atomic="true">
    <span className={`remote-task-label${!opening && status ? ` is-${status}` : ""}`} title={!opening && status === "error" ? "上一轮执行中断，已有对话和文件保留，可以继续发送消息" : undefined}>
      {loading ? <span className="remote-spinner" aria-hidden="true" /> : <i className={`remote-task-dot is-${status}`} aria-hidden="true" />}
      {opening ? "正在读取任务" : remoteTaskLabels[status!]}
    </span>
  </div>;
}

export function RemoteExecutionControl({ status, disabled, onControl }: { status?: RemoteTaskStatus; disabled: boolean; onControl(action: "stop" | "resume"): void }): JSX.Element | null {
  const action = status === "running" || status === "waiting" ? "stop" : status === "paused" ? "resume" : null;
  if (!action) return null;
  return <button type="button" className={`remote-button remote-execution-control is-${action}`} aria-label={action === "stop" ? "停止执行" : "继续任务"} title={action === "stop" ? "停止当前执行；独立运行的服务可能继续运行" : "继续当前任务"} disabled={disabled} onClick={() => onControl(action)}>
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{action === "stop" ? <rect x="6" y="6" width="12" height="12" rx="2" /> : <path d="m8 5 11 7-11 7Z" />}</svg>
  </button>;
}
