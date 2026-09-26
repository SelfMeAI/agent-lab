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

export type KimiCustomFields = Record<string, { fieldId: string; value: string }>;

/** Only the version-pinned Kimi bridge may add custom-input companion fields. */
export function kimiFormCustomFields(params: Obj): KimiCustomFields | null {
  const metadata = object(params._meta).selfmeKimiOther;
  if (metadata === undefined) return {};
  const bridge = object(metadata), properties = object(object(params.requestedSchema).properties);
  if (bridge.version !== 1 || !Array.isArray(bridge.fields) || !bridge.fields.length || bridge.fields.length > 16) return null;
  const fields: KimiCustomFields = Object.create(null);
  const companionIds = new Set<string>();
  for (const entry of bridge.fields) {
    const field = object(entry), id = text(field.id), fieldId = text(field.fieldId), value = text(field.value);
    const primary = object(properties[id]), companion = object(properties[fieldId]);
    const options = primary.type === "array" ? object(primary.items).anyOf : primary.oneOf;
    if (!/^q\d+$/.test(id) || fieldId !== `${id}_other` || !value || fields[id] || companionIds.has(fieldId)
      || !["string", "array"].includes(text(primary.type)) || companion.type !== "string"
      || !Array.isArray(options) || options.filter(option => object(option).const === value).length !== 1) return null;
    fields[id] = { fieldId, value }; companionIds.add(fieldId);
  }
  return fields;
}

/** Kimi's native ACP form, plus the bridge's enum + optional Other text pair. */
export function kimiFormQuestions(params: Obj): AgentQuestion[] {
  if (params.mode !== "form") return [];
  const schema = object(params.requestedSchema), properties = object(schema.properties);
  const customFields = kimiFormCustomFields(params);
  if (!customFields) return [];
  const companions = new Set(Object.values(customFields).map(field => field.fieldId));
  const fields = Object.entries(properties).filter(([id]) => !companions.has(id));
  if (schema.type !== "object" || !fields.length || fields.length > 16) return [];
  const messages = text(params.message).split("\n");
  const result: AgentQuestion[] = [];
  for (const [index, [id, value]] of fields.entries()) {
    const field = object(value), multiSelect = field.type === "array";
    if (!multiSelect && field.type !== "string") return [];
    const nativeOptions = multiSelect ? object(field.items).anyOf : field.oneOf;
    const options = choices(Array.isArray(nativeOptions) ? nativeOptions.filter(value => !customFields[id] || object(value).const !== customFields[id].value).map(value => {
      const option = object(value); return { label: option.const, description: option.description };
    }) : undefined);
    if (!options?.length) return [];
    result.push({ id, header: text(field.title), question: messages[index] || text(field.title), detail: text(field.description) || undefined, options, multiSelect, allowCustom: customFields[id] !== undefined });
  }
  return result;
}

/** Serialize Other as a valid enum selection AND its companion text field. */
export function kimiFormAnswerContent(questions: AgentQuestion[], answers: AgentQuestionAnswers, customFields: KimiCustomFields): Obj {
  const content: Obj = Object.create(null);
  for (const q of questions) {
    const custom = answers[q.id].filter(value => !q.options.some(option => option.label === value));
    const values = answers[q.id].filter(value => q.options.some(option => option.label === value));
    if (custom.length) {
      const field = customFields[q.id];
      if (!field || custom.length > 1) throw new Error("每个问题只能填写一个自定义答案");
      values.push(field.value);
      content[field.fieldId] = custom[0];
    }
    content[q.id] = q.multiSelect ? values : values[0];
  }
  return content;
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
