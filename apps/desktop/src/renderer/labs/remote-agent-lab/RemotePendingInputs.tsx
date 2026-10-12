import type { JSX } from "react";
import type { RemoteInputQueue } from "../../../../../../packages/contracts/src/remote-agent";

export function RemotePendingInputs({ queue, running, disabled, onRemove, onSteer }: { queue: RemoteInputQueue; running: boolean; disabled: boolean; onRemove(id: string): void; onSteer(id: string): void }): JSX.Element | null {
  if (!queue.items.length) return null;
  return <section className="remote-input-queue" aria-label="待发消息">
    <header><span>待发消息 <small>{queue.items.length}</small></span><small>{queue.paused ? "已保留 · 点击继续后发送" : queue.items.every(item => item.state === "sending") ? "正在提交…" : "当前轮结束后合并发送"}</small></header>
    <div className="remote-input-queue__list">{queue.items.map(item => <div className={`remote-input-queue__item${item.state === "sending" ? " is-sending" : ""}`} key={item.id}>
      <div title={item.text || item.files.map(file => file.name).join("、")}><p>{item.text || item.files.map(file => file.name).join("、")}</p>{item.files.length > 0 && <small>附件 · {item.files.map(file => file.name).join("、")}</small>}{item.error ? <small className="remote-input-queue__error">{item.error}</small> : item.state === "sending" && <small><i className="remote-spinner" aria-hidden="true" />正在提交…</small>}</div>
      <button type="button" className="remote-input-queue__steer" disabled={disabled || !running || item.state === "sending"} title={running ? "只将这条消息补充到当前轮" : "当前没有可补充的工作轮次"} onClick={() => onSteer(item.id)}>Steer<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="m4 12 8-8M5 4h7v7" /></svg></button>
      <button type="button" className="remote-input-queue__remove" disabled={disabled || item.state === "sending"} aria-label={`删除待发消息：${item.text || "附件"}`} title="删除待发消息" onClick={() => onRemove(item.id)}>×</button>
    </div>)}</div>
  </section>;
}
