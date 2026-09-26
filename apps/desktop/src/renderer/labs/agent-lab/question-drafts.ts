import type { AgentQuestion, AgentQuestionAnswers } from "../../../../../../packages/contracts/src/index";

export interface QuestionDraft {
  selections: Record<string, number[]>;
  customText: Record<string, string>;
}

export const emptyQuestionDraft: QuestionDraft = { selections: {}, customText: {} };

export function questionSelection(draft: QuestionDraft, id: string): number[] {
  return Array.isArray(draft.selections[id]) ? draft.selections[id] : [];
}

export function questionCustomText(draft: QuestionDraft, id: string): string {
  return typeof draft.customText[id] === "string" ? draft.customText[id] : "";
}

export function toggleQuestionChoice(draft: QuestionDraft, question: AgentQuestion, index: number): QuestionDraft {
  const current = questionSelection(draft, question.id);
  const selected = question.multiSelect ? current.includes(index) ? current.filter(value => value !== index) : [...current, index].sort((a, b) => a - b) : [index];
  return { ...draft, selections: { ...draft.selections, [question.id]: selected } };
}

export function questionDraftAnswers(questions: AgentQuestion[], draft: QuestionDraft): AgentQuestionAnswers | undefined {
  if (!questions.length) return undefined;
  const result: AgentQuestionAnswers = Object.create(null);
  let total = 0;
  for (const q of questions) {
    const selected = questionSelection(draft, q.id);
    if (!q.multiSelect && selected.length > 1) return undefined;
    const values = selected.flatMap(index => {
      if (q.options[index]) return [q.options[index].label];
      return index === q.options.length && q.allowCustom ? [questionCustomText(draft, q.id).trim()] : [];
    });
    if (!q.options.length && q.allowCustom && !selected.length) values.push(questionCustomText(draft, q.id).trim());
    if (!values.length || values.some(value => !value || value.length > 8000)
      || (q.options.length && values.length !== selected.length) || new Set(values).size !== values.length) return undefined;
    total += values.reduce((sum, value) => sum + value.length, 0);
    if (total > 32000) return undefined;
    result[q.id] = values;
  }
  return result;
}
