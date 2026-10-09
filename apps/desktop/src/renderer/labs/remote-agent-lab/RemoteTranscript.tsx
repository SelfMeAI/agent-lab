import { useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { RemoteAgentId, RemoteItem, RemoteQuestion } from "../../../../../../packages/contracts/src/remote-agent";
import { clockTime, exactTime, toolDuration } from "../agent-lab/conversation-time";
import { RemoteMark, remoteEngines } from "./RemoteAgentPage";

export function RemoteMarkdown({ value }: { value: string }): JSX.Element {
  return <div className="remote-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <span className="remote-link" title={href}>{children ?? href}</span>, img: ({ alt }) => <span>[图片：{alt || "请到产物中查看"}]</span> }}>{value}</ReactMarkdown></div>;
}
export function RemoteTranscriptItem({ item, engine, busy, onApproval, onAnswer }: { item: RemoteItem; engine: RemoteAgentId; busy: boolean;
  onApproval(id: string, decision: "once" | "always" | "reject"): void; onAnswer(id: string, answers: Record<string, string[]> | null): void }): JSX.Element {
  const time = item.at && <time dateTime={item.at} title={exactTime(item.at) ?? undefined}>{clockTime(item.at)}</time>;
  if (item.question) return <RemoteQuestionCard key={item.question.id} question={item.question} busy={busy} onAnswer={onAnswer} />;
  if (item.approval) return <article className="remote-approval"><header><span className="remote-approval__mark">!</span><strong>{item.approval.title}</strong>{time}</header><pre>{item.approval.detail}</pre><footer><button type="button" className="remote-button" disabled={busy} onClick={() => onApproval(item.approval!.id, "reject")}>拒绝</button>{item.approval.canAlways && <button className="remote-button" disabled={busy} type="button" title={engine === "openhands" ? "本任务后续工具操作不再询问，新任务仍需确认" : "按照引擎原生规则记住此类命令授权"} onClick={() => onApproval(item.approval!.id, "always")}>{engine === "openhands" ? "本任务始终允许" : "始终允许"}</button>}<button className="remote-button remote-button--primary" disabled={busy} type="button" onClick={() => onApproval(item.approval!.id, "once")}>允许一次</button></footer></article>;
  if (item.tool) {
    const tool = item.tool, duration = tool.startedAt && tool.endedAt ? toolDuration(new Date(tool.endedAt).getTime() - new Date(tool.startedAt).getTime()) : null;
    return <article className="remote-tool">{item.text && <RemoteMarkdown value={item.text} />}<details open={tool.status === "running" || tool.status === "failed"}><summary><span className={tool.status === "running" ? "remote-spinner" : `remote-tool__state is-${tool.status}`} aria-hidden="true">{tool.status === "completed" ? "✓" : tool.status === "failed" ? "!" : tool.status === "rejected" ? "−" : ""}</span><strong>{tool.title}</strong><small>{tool.status === "running" ? "执行中" : tool.status === "completed" ? "已完成" : tool.status === "failed" ? "失败" : "已拒绝"}</small>{duration && <small title="工具执行用时">{duration}</small>}{time}</summary><div className="remote-tool__detail">{tool.input && <pre className="remote-tool__input">{tool.input}</pre>}{tool.diff && <div className="remote-diff" aria-label="文件变更">{tool.diff.split("\n").map((line, i) => <div key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "is-added" : line.startsWith("-") && !line.startsWith("---") ? "is-removed" : ""}>{line || " "}</div>)}</div>}{tool.output && <pre className="remote-tool__output">{tool.output}</pre>}{tool.path && <small className="remote-tool__path">{tool.path}</small>}</div></details></article>;
  }
  if (item.role === "notice") return <div className="remote-message-notice">{item.text}</div>;
  return <article className={`remote-message remote-message--${item.role}`}>
    {item.role === "user" ? <span className="remote-user-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="12" cy="8" r="3.1" /><path d="M5.4 19c.6-3.4 2.9-5.1 6.6-5.1s6 1.7 6.6 5.1" /></svg></span> : <RemoteMark engine={engine} />}
    <div className="remote-message__body"><header><span>{item.role === "user" ? "You" : remoteEngines[engine].name}</span>{time}{item.streaming && <span className="remote-spinner" aria-label="正在输出" />}</header>{item.reasoning && <details className="remote-reasoning"><summary>思考过程</summary><RemoteMarkdown value={item.reasoning} /></details>}{item.role === "user" ? <p className="remote-user-text">{item.text}</p> : <RemoteMarkdown value={item.text} />}</div>
  </article>;
}
function RemoteQuestionCard({ question, busy, onAnswer }: { question: RemoteQuestion; busy: boolean; onAnswer(id: string, answers: Record<string, string[]> | null): void }): JSX.Element {
  const [selected, setSelected] = useState<Record<string, string[]>>({}); const [free, setFree] = useState<Record<string, string>>({});
  const answers = remoteQuestionAnswers(question, selected, free);
  return <form className="remote-approval remote-question" onSubmit={event => { event.preventDefault(); onAnswer(question.id, answers); }}><header><span className="remote-approval__mark">?</span><strong>需要你补充信息</strong></header>{question.questions.map(q => <fieldset key={q.id} disabled={busy}><legend>{q.title}</legend><p>{q.prompt}</p>{q.options.map(option => <label className="remote-question__option" key={option.label}><input type={q.multiple ? "checkbox" : "radio"} name={q.id} checked={(selected[q.id] ?? []).includes(option.label)} onChange={() => setSelected(previous => ({ ...previous, [q.id]: q.multiple ? (previous[q.id] ?? []).includes(option.label) ? (previous[q.id] ?? []).filter(value => value !== option.label) : [...(previous[q.id] ?? []), option.label] : [option.label] }))} /><span>{option.label}{option.description && <small>{option.description}</small>}</span></label>)}{(q.other || !q.options.length || q.secret) && <input className="remote-question__free" type={q.secret ? "password" : "text"} aria-label={q.title + "补充回答"} placeholder={q.options.length ? "其他回答（可选）" : "输入你的回答"} value={free[q.id] ?? ""} onChange={event => setFree(previous => ({ ...previous, [q.id]: event.target.value }))} />}</fieldset>)}<footer><button className="remote-button" type="button" disabled={busy} onClick={() => onAnswer(question.id, null)}>取消</button><button className="remote-button remote-button--primary" type="submit" disabled={busy || Object.values(answers).some(value => !value.length)}>提交回答</button></footer></form>;
}

/** Other replaces a single choice; only a native multi-select may include both. */
export function remoteQuestionAnswers(question: RemoteQuestion, selected: Record<string, string[]>, free: Record<string, string>): Record<string, string[]> {
  return Object.fromEntries(question.questions.map(q => {
    const other = free[q.id]?.trim();
    return [q.id, other ? q.multiple ? [...(selected[q.id] ?? []), other] : [other] : selected[q.id] ?? []];
  }));
}
