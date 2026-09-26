import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { kimiFormAnswerContent, kimiFormCustomFields, kimiFormQuestions, validateQuestionAnswers } from "./user-questions";

type Obj = Record<string, any>;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const questions = [
  { question: "游戏？", header: "类型", body: "选择或补充", options: [{ label: "2048", description: "合并" }, { label: "扫雷", description: "推理" }] },
  { question: "设备？", header: "平台", multiSelect: true, options: [{ label: "电脑" }, { label: "手机" }] },
];
let mappers: { form(questions: Obj[], sessionId: string, toolCallId?: string): Obj; answers(questions: Obj[], response: Obj): Obj | null };
let transform: (source: string) => string, source: string;

beforeAll(async () => {
  const loader = await import(pathToFileURL(join(root, "runtimes/kimi-code/steering-loader.mjs")).href);
  const bridge = await import(pathToFileURL(join(root, "runtimes/kimi-code/questions-bridge.mjs")).href);
  source = await readFile(join(root, "runtimes/kimi-code/node_modules/@moonshot-ai/kimi-code/dist/main.mjs"), "utf8");
  transform = loader.transformKimi;
  const patched = transform(source);
  // Execute the actual pinned upstream pure mappers, not look-alike mocks.
  const start = patched.indexOf("function questionPropertyKey(questionIndex) {"), end = patched.indexOf("var init_question$1 =", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  mappers = new Function(`${bridge.kimiQuestionBridgeSource}\n${patched.slice(start, end)}\nreturn { form: questionRequestToElicitationParams, answers: elicitationResponseToQuestionAnswers };`)();
});

describe("Kimi's version-pinned Other form bridge", () => {
  it("keeps native enums/schema valid and renders companion fields as Other, not extra questions", () => {
    const form = mappers.form(questions, "session", "tool");
    expect(form).toMatchObject({ sessionId: "session", toolCallId: "tool", mode: "form", message: "游戏？\n设备？", requestedSchema: { required: ["q0", "q1"] } });
    expect(Object.keys(form.requestedSchema.properties)).toEqual(["q0", "q1", "q0_other", "q1_other"]);
    expect(form.requestedSchema.properties.q0.oneOf.at(-1)).toMatchObject({ title: "Other" });
    expect(form.requestedSchema.properties.q1_other).toMatchObject({ type: "string", maxLength: 8000 });
    expect(kimiFormQuestions(form)).toEqual([
      { id: "q0", question: "游戏？", header: "类型", detail: "选择或补充", options: [{ label: "2048", description: "合并" }, { label: "扫雷", description: "推理" }], multiSelect: false, allowCustom: true },
      { id: "q1", question: "设备？", header: "平台", detail: undefined, options: [{ label: "电脑", description: "" }, { label: "手机", description: "" }], multiSelect: true, allowCustom: true },
    ]);
  });
  it.each([
    [{ q0: ["扫雷"], q1: ["电脑", "手机"] }, { "游戏？": "扫雷", "设备？": "电脑, 手机" }],
    [{ q0: ["象棋"], q1: ["手机", "电脑", "主机"] }, { "游戏？": "象棋", "设备？": "电脑, 手机, 主机" }],
    [{ q0: ["象棋\n加一个主题"], q1: ["主机"] }, { "游戏？": "象棋\n加一个主题", "设备？": "主机" }],
  ])("round-trips actual single/multi/custom answers %j", (input, expected) => {
    const form = mappers.form(questions, "session"), parsed = kimiFormQuestions(form);
    const checked = validateQuestionAnswers(parsed, input);
    const content = kimiFormAnswerContent(parsed, checked, kimiFormCustomFields(form)!);
    expect(mappers.answers(questions, { action: "accept", content })).toEqual(expected);
    if (input.q0[0] === "扫雷") expect(content).toEqual({ q0: "扫雷", q1: ["电脑", "手机"] });
    else expect(content).toMatchObject({ q0: form._meta.selfmeKimiOther.fields[0].value, q0_other: input.q0[0] });
  });
  it("does not collide with a declared label that looks like the synthetic Other value", () => {
    const qs = [{ question: "选择？", options: [{ label: "__selfme_kimi_other__" }, { label: "B" }] }];
    const form = mappers.form(qs, "session"), parsed = kimiFormQuestions(form), fields = kimiFormCustomFields(form)!;
    expect(fields.q0.value).not.toBe(qs[0].options[0].label);
    expect(parsed[0].options.map(o => o.label)).toContain("__selfme_kimi_other__");
    const content = kimiFormAnswerContent(parsed, validateQuestionAnswers(parsed, { q0: ["__selfme_kimi_other__"] }), fields);
    expect(mappers.answers(qs, { action: "accept", content })).toEqual({ "选择？": "__selfme_kimi_other__" });
  });
  it.each(["cancel", "decline"])("does not fabricate answers on %s", action => {
    const form = mappers.form(questions, "session"), fields = kimiFormCustomFields(form)!;
    expect(mappers.answers(questions, { action, content: { q0: fields.q0.value, q0_other: "象棋" } })).toBeNull();
  });
  it("ignores unselected Other text, unknown values and empty or oversized custom input", () => {
    const form = mappers.form(questions, "session"), fields = kimiFormCustomFields(form)!;
    expect(mappers.answers(questions, { action: "accept", content: { q0: "扫雷", q0_other: "象棋" } })).toEqual({ "游戏？": "扫雷" });
    for (const q0_other of [undefined, "", "  ", "x".repeat(8001)]) {
      expect(mappers.answers(questions, { action: "accept", content: { q0: fields.q0.value, q0_other } })).toBeNull();
    }
    expect(mappers.answers(questions, { action: "accept", content: { q0: "自填但未选 Other" } })).toBeNull();
  });
  it("rejects incomplete submissions and multiple free-text values for one question", () => {
    const form = mappers.form(questions, "session"), parsed = kimiFormQuestions(form), fields = kimiFormCustomFields(form)!;
    expect(() => validateQuestionAnswers(parsed, { q0: [""], q1: ["电脑"] })).toThrow(/回答/);
    expect(() => validateQuestionAnswers(parsed, { q0: ["象棋"] })).toThrow(/回答/);
    expect(() => kimiFormAnswerContent(parsed, { q0: ["象棋"], q1: ["主机", "平板"] }, fields)).toThrow(/一个自定义/);
  });
  it.each(["version", "field", "value", "duplicate"])("fails closed on malformed bridge metadata: %s", invalid => {
    const form = mappers.form(questions, "session"), meta = form._meta.selfmeKimiOther;
    if (invalid === "version") meta.version = 2;
    if (invalid === "field") meta.fields[0].fieldId = "q1";
    if (invalid === "value") meta.fields[0].value = "不存在";
    if (invalid === "duplicate") meta.fields.push(meta.fields[0]);
    expect(kimiFormQuestions(form)).toEqual([]);
  });
  it.each(["questionRequestToElicitationParams", "elicitationResponseToQuestionAnswers"])("refuses to launch when upstream %s changes", name => {
    expect(() => transform(source.replace(`function ${name}(`, `function changed_${name}(`))).toThrow(/signature changed/);
  });
});
