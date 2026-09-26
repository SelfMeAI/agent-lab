import { useId, useState, type JSX } from "react";
import type { AgentQuestionAnswers, ApprovalRequest } from "../../../../../../packages/contracts/src/index";
import { clockTime, exactTime } from "./conversation-time";
import { emptyQuestionDraft, questionCustomText, questionDraftAnswers, questionSelection, toggleQuestionChoice, type QuestionDraft } from "./question-drafts";
import "./user-questions.css";

export function UserQuestionCard({ approval, at, busy, draft: controlledDraft, onDraftChange, onAnswer }: {
  approval: ApprovalRequest;
  at: string;
  busy: boolean;
  draft?: QuestionDraft;
  onDraftChange?(draft: QuestionDraft): void;
  onAnswer(requestId: string | number, optionId: string, answers?: AgentQuestionAnswers): void;
}): JSX.Element {
  const prefix = useId();
  const [localDraft, setLocalDraft] = useState(emptyQuestionDraft);
  const draft = controlledDraft ?? localDraft;
  const update = (next: QuestionDraft): void => { setLocalDraft(next); onDraftChange?.(next); };
  const questions = approval.questions ?? [];
  const answers = questionDraftAnswers(questions, draft);
  const submit = approval.options.find(option => option.kind.includes("allow"));
  const cancel = approval.options.find(option => option.kind.includes("reject"));
  return <form className="agent-question" aria-label="回答 Agent 的问题" onSubmit={event => {
    event.preventDefault();
    if (!busy && answers && submit) onAnswer(approval.requestId, submit.optionId, answers);
  }}>
    <div className="agent-question__heading"><span className="agent-question__mark" aria-hidden="true">?</span><strong>需要你回答</strong><time dateTime={at} title={exactTime(at) ?? undefined}>{clockTime(at)}</time></div>
    {!questions.length && <p className="agent-question__invalid" role="alert">问题内容不完整，无法提交答案。请取消后让 Agent 重新提问。</p>}
    {questions.map((q, index) => {
      const selected = questionSelection(draft, q.id);
      const custom = !q.options.length || selected.includes(q.options.length);
      return <fieldset className="agent-question__field" disabled={busy} key={q.id}>
        <legend><span>{q.header || `问题 ${index + 1}`}</span><small>{q.options.length ? q.multiSelect ? "可多选" : "单选" : "填写答案"}</small></legend>
        <p className="agent-question__text" id={`${prefix}-${index}-text`}>{q.question}</p>
        {q.detail && <p className="agent-question__detail">{q.detail}</p>}
        <div className="agent-question__choices">{q.options.map((option, optionIndex) => <label className={`agent-question__choice${selected.includes(optionIndex) ? " is-selected" : ""}`} key={option.label}>
          <input type={q.multiSelect ? "checkbox" : "radio"} name={`${prefix}-${index}`} checked={selected.includes(optionIndex)} onChange={() => update(toggleQuestionChoice(draft, q, optionIndex))} />
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        </label>)}
          {q.allowCustom && q.options.length > 0 && <label className={`agent-question__choice${custom ? " is-selected" : ""}`}>
            <input type={q.multiSelect ? "checkbox" : "radio"} name={`${prefix}-${index}`} checked={custom} onChange={() => update(toggleQuestionChoice(draft, q, q.options.length))} />
            <span><strong>其他</strong><small>填写自己的答案</small></span>
          </label>}
        </div>
        {q.allowCustom && custom && (q.secret
          ? <input className="agent-question__custom" type="password" aria-label={`${q.header || q.question}：填写答案`} autoComplete="off" value={questionCustomText(draft, q.id)} maxLength={8000} onChange={event => update({ ...draft, customText: { ...draft.customText, [q.id]: event.target.value } })} />
          : <textarea className="agent-question__custom" aria-label={`${q.header || q.question}：填写答案`} aria-describedby={`${prefix}-${index}-text`} placeholder="填写你的答案…" rows={2} maxLength={8000} value={questionCustomText(draft, q.id)} onChange={event => update({ ...draft, customText: { ...draft.customText, [q.id]: event.target.value } })} />)}
      </fieldset>;
    })}
    <div className="agent-question__footer"><small>回答后，Agent 将按你的选择继续</small><div>
      {cancel && <button type="button" disabled={busy} onClick={() => onAnswer(approval.requestId, cancel.optionId)}>取消回答</button>}
      {submit && <button className="is-submit" type="submit" disabled={busy || !answers}>{busy ? "正在提交…" : "提交答案"}</button>}
    </div></div>
  </form>;
}
