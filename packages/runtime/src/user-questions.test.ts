import { describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RunEvent } from "../../contracts/src/index";
import { AcpAdapter } from "./acp";
import { CodexAdapter } from "./codex";
import { DshAdapter } from "./dsh";
import { codexQuestions, dshQuestions, kimiFormQuestions, qwenQuestions, validateQuestionAnswers } from "./user-questions";

const nativeQuestions = [{ header: "游戏类型", question: "想加哪个游戏？", options: [{ label: "2048", description: "数字合并" }, { label: "扫雷", description: "推理" }], multiSelect: false }];
describe("native human-question contracts", () => {
  it("recognizes Qwen's explicit metadata without mistaking approvals for questions", () => {
    expect(qwenQuestions({ title: "Ask user 1 question" })).toBeUndefined();
    expect(qwenQuestions({ _meta: { qwenInteractionKind: "user_question", qwenQuestions: nativeQuestions } })).toMatchObject([{ id: "0", question: "想加哪个游戏？", allowCustom: true }]);
    expect(qwenQuestions({ _meta: { qwenInteractionKind: "user_question", qwenQuestions: [{}] } })).toEqual([]);
  });
  it("preserves Codex question IDs, custom answers and secret input", () => {
    expect(codexQuestions([{ ...nativeQuestions[0], id: "game", isOther: true }, { id: "key", header: "密码", question: "密码？", options: null, isSecret: true }])).toMatchObject([{ id: "game", allowCustom: true }, { id: "key", allowCustom: true, secret: true }]);
    expect(codexQuestions([{ ...nativeQuestions[0], id: "same" }, { ...nativeQuestions[0], id: "same" }])).toEqual([]);
  });
  it("preserves all Kimi form fields and their native multi-select constraints", () => {
    const q = kimiFormQuestions({ mode: "form", message: "游戏？\n设备？", requestedSchema: { type: "object", properties: {
      q0: { type: "string", title: "类型", oneOf: [{ const: "2048", description: "合并" }, { const: "扫雷" }] },
      q1: { type: "array", title: "设备", items: { anyOf: [{ const: "电脑" }, { const: "手机" }] } },
    } } });
    expect(q).toMatchObject([{ id: "q0", question: "游戏？", multiSelect: false, allowCustom: false }, { id: "q1", multiSelect: true }]);
    expect(validateQuestionAnswers(q, { q0: ["2048"], q1: ["电脑", "手机"] })).toEqual({ q0: ["2048"], q1: ["电脑", "手机"] });
    expect(() => validateQuestionAnswers(q, { q0: ["自定义"], q1: ["电脑"] })).toThrow(/范围/);
    expect(kimiFormQuestions({ mode: "url" })).toEqual([]);
  });
  it("preserves DSH's native free-text and multi-select questions", () => {
    expect(dshQuestions([{ id: "a", question: "补充？" }, { ...nativeQuestions[0], id: "b", multiSelect: true }])).toMatchObject([{ id: "a", options: [], allowCustom: true }, { id: "b", multiSelect: true }]);
  });
  it.each([undefined, {}, { "0": "2048" }, { "0": [""] }, { "0": ["2048", "扫雷"] }, { "0": ["2048"], "01": ["扫雷"] }, { "0": ["x".repeat(8001)] }])("rejects incomplete or invalid answers %j", value => {
    const q = qwenQuestions({ _meta: { qwenInteractionKind: "user_question", qwenQuestions: nativeQuestions } })!;
    expect(() => validateQuestionAnswers(q, value)).toThrow();
  });
});

// Exercise wire-level expiry without spawning a model; native-runtime tests
// separately cover full question/answer, cancel and task-stop round trips.
describe("native question request expiry", () => {
  it.each(["qwen-code", "kimi-code", "codex", "dsh"])("removes expired %s requests without leaving the session waiting", async id => {
    const provider = async () => ({ baseUrl: "", model: "", apiKey: "" });
    const adapter = id === "codex" ? new CodexAdapter({ executable: "unused", homeDirectory: "unused", provider })
      : id === "dsh" ? new DshAdapter({ entryPoint: "unused", homeDirectory: "unused", nodeExecutable: "unused", steeringLoader: "unused", provider })
        : new AcpAdapter({ id, label: id, probePath: "unused", readyDetail: "", missingDetail: "", launch: async () => ({ executable: "unused", args: [], env: {} }) });
    const internals = adapter as unknown as {
      child: ChildProcessWithoutNullStreams;
      handleLine(child: ChildProcessWithoutNullStreams, line: string): void;
      handleServerRequest(message: Record<string, unknown>, method: string): void;
      handleNotification(method: string, params: Record<string, unknown>): void;
    };
    const events: RunEvent[] = [];
    adapter.onEvent(event => events.push(event));
    internals.child = {} as ChildProcessWithoutNullStreams;
    const request = (requestId: number): void => {
      if (id === "codex") internals.handleServerRequest({ id: requestId, params: { questions: [{ ...nativeQuestions[0], id: "game", isOther: true }] } }, "item/tool/requestUserInput");
      else {
        const message = id === "dsh" ? { id: requestId, method: "_selfme/user-question", params: { questions: [{ ...nativeQuestions[0], id: "game" }] } }
          : id === "kimi-code" ? { id: requestId, method: "elicitation/create", params: { mode: "form", message: "游戏？", requestedSchema: { type: "object", properties: { game: { type: "string", oneOf: [{ const: "2048" }] } } } } }
            : { id: requestId, method: "session/request_permission", params: { options: [{ optionId: "submit", kind: "allow_once", name: "Submit" }], toolCall: { _meta: { qwenInteractionKind: "user_question", qwenQuestions: nativeQuestions } } } };
        internals.handleLine(internals.child, JSON.stringify(message));
      }
    };
    const expire = (requestId: number): void => {
      if (id === "codex") internals.handleNotification("serverRequest/resolved", { requestId });
      else internals.handleLine(internals.child, JSON.stringify({ method: "$/cancel_request", params: { id: requestId } }));
    };
    request(1); request(2);
    expire(1);
    expect(events.at(-1)).toMatchObject({ kind: "approval_result", approval: { requestId: 1 } });
    await expect(adapter.respondApproval(1, "submit", {})).rejects.toThrow(/失效/);
    expire(2);
    expect(events.at(-1)).toMatchObject({ kind: "status", phase: "running" });
    const count = events.length;
    expire(2);
    expect(events).toHaveLength(count);
  });
});
