import type { AgentQuestion, AgentQuestionAnswers } from "../../contracts/src/index";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

function choices(value: unknown): AgentQuestion["options"] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const result = value.map(value => { const entry = object(value); return { label: text(entry.label), description: text(entry.description) }; });
  return result.every(entry => entry.label.trim()) && new Set(result.map(entry => entry.label)).size === result.length ? result : null;
}

/** Parse known native protocols only. Malformed question requests fail closed. */
export function qwenQuestions(toolCall: unknown): AgentQuestion[] | undefined {
  const meta = object(object(toolCall)._meta);
  if (meta.qwenInteractionKind !== "user_question") return undefined;
  const input = meta.qwenQuestions;
  if (!Array.isArray(input) || !input.length || input.length > 4) return [];
  const result: AgentQuestion[] = [];
  for (const [index, value] of input.entries()) {
    const q = object(value), options = choices(q.options);
    if (!text(q.question).trim() || !options?.length) return [];
    result.push({ id: String(index), header: text(q.header), question: text(q.question), options, multiSelect: q.multiSelect === true, allowCustom: true });
  }
  return result;
}

export function codexQuestions(value: unknown): AgentQuestion[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) return [];
  const result: AgentQuestion[] = [];
  for (const item of value) {
    const q = object(item), options = q.options == null ? [] : choices(q.options);
    if (!text(q.id).trim() || !text(q.question).trim() || !options || result.some(previous => previous.id === q.id)) return [];
    result.push({ id: text(q.id), header: text(q.header), question: text(q.question), options, multiSelect: false, allowCustom: q.isOther === true || options.length === 0, secret: q.isSecret === true });
  }
  return result;
}

export function dshQuestions(value: unknown): AgentQuestion[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) return [];
  const result: AgentQuestion[] = [];
  for (const item of value) {
    const q = object(item), options = q.options === undefined ? [] : choices(q.options);
    if (!text(q.id).trim() || !text(q.question).trim() || !options || result.some(previous => previous.id === q.id)) return [];
    result.push({ id: text(q.id), header: text(q.header), question: text(q.question), detail: text(q.detail) || undefined, options, multiSelect: q.multiSelect === true, allowCustom: true });
  }
  return result;
}

/** Kimi's native ACP form preserves all questions and multi-select. */
export function kimiFormQuestions(params: Obj): AgentQuestion[] {
  if (params.mode !== "form") return [];
  const schema = object(params.requestedSchema), properties = object(schema.properties);
  const fields = Object.entries(properties);
  if (schema.type !== "object" || !fields.length || fields.length > 16) return [];
  const messages = text(params.message).split("\n");
  const result: AgentQuestion[] = [];
  for (const [index, [id, value]] of fields.entries()) {
    const field = object(value), multiSelect = field.type === "array";
    if (!multiSelect && field.type !== "string") return [];
    const nativeOptions = multiSelect ? object(field.items).anyOf : field.oneOf;
    const options = choices(Array.isArray(nativeOptions) ? nativeOptions.map(value => {
      const option = object(value); return { label: option.const, description: option.description };
    }) : undefined);
    if (!options?.length) return [];
    result.push({ id, header: text(field.title), question: messages[index] || text(field.title), detail: text(field.description) || undefined, options, multiSelect, allowCustom: false });
  }
  return result;
}

/** Validate in the runtime too: renderer/IPC payloads are not trusted. */
export function validateQuestionAnswers(questions: AgentQuestion[], value: unknown): AgentQuestionAnswers {
  const answers = object(value);
  if (!questions.length || Object.keys(answers).length !== questions.length
    || Object.keys(answers).some(id => !questions.some(q => q.id === id))) throw new Error("请回答所有问题后再提交");
  let total = 0;
  const result: AgentQuestionAnswers = Object.create(null);
  for (const q of questions) {
    const answer = answers[q.id];
    if (!Array.isArray(answer) || !answer.length || (!q.multiSelect && answer.length !== 1)
      || answer.some(text => typeof text !== "string" || !text.trim()) || new Set(answer).size !== answer.length) throw new Error("请回答所有问题后再提交");
    if (answer.some(text => text.length > 8000) || (total += answer.reduce((n, text) => n + text.length, 0)) > 32000) throw new Error("答案过长，请缩短后再提交");
    if (!q.allowCustom && answer.some(text => !q.options.some(option => option.label === text))) throw new Error("答案不在可选范围内");
    result[q.id] = [...answer];
  }
  return result;
}
