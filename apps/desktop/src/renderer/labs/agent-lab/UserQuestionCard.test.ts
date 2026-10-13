import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentQuestion, ApprovalRequest } from "../../../../../../packages/contracts/src/index";
import { kimiFormQuestions } from "../../../../../../packages/runtime/src/user-questions";
import { TranscriptItem } from "./AgentWorkspace";
import { emptyQuestionDraft, questionDraftAnswers, toggleQuestionChoice } from "./question-drafts";
import { createSessionInteractions } from "./session-interactions";

const question: AgentQuestion = { id: "0", header: "游戏类型", question: "想加哪个游戏？", options: [{ label: "2048", description: "经典数字合并" }, { label: "扫雷", description: "经典推理" }], multiSelect: false, allowCustom: true };
const approval: ApprovalRequest = { requestId: 7, title: "Ask user 1 question", questions: [question], options: [{ optionId: "proceed_once", name: "Submit", kind: "allow_once" }, { optionId: "cancel", name: "Cancel", kind: "reject_once" }] };

describe("user question card", () => {
  it.each(["qwen-code", "kimi-code", "codex", "dsh", "pi"] as const)("shows the actual question instead of authorization buttons for %s", runtimeId => {
    const markup = renderToStaticMarkup(createElement(TranscriptItem, { runtimeId, workspace: "/workspace", onApprove: () => {}, approvalBusy: false,
      entry: { id: "question", kind: "approval", runId: "run", at: "2026-09-27T00:00:00Z", text: "Ask user 1 question", approval } }));
    for (const value of ["需要你回答", "想加哪个游戏？", "2048", "经典数字合并", "其他", "提交答案", "取消回答"]) expect(markup).toContain(value);
    for (const value of ["Ask user", ">Submit<", ">Cancel<", "需要你确认"]) expect(markup).not.toContain(value);
    expect(markup).toContain('type="submit" disabled=""');
    expect(markup).not.toContain('checked=""');
  });
  it("enables submission only for complete answers and keeps selection order deterministic", () => {
    expect(questionDraftAnswers([question], emptyQuestionDraft)).toBeUndefined();
    const other = toggleQuestionChoice(emptyQuestionDraft, question, 2);
    expect(questionDraftAnswers([question], other)).toBeUndefined();
    expect(questionDraftAnswers([question], { ...other, customText: { "0": "  象棋  " } })).toEqual({ "0": ["象棋"] });
    const multi = { ...question, multiSelect: true };
    const selected = toggleQuestionChoice(toggleQuestionChoice(emptyQuestionDraft, multi, 1), multi, 0);
    expect(questionDraftAnswers([multi], selected)).toEqual({ "0": ["2048", "扫雷"] });
    expect(questionDraftAnswers([multi], toggleQuestionChoice(selected, multi, 1))).toEqual({ "0": ["2048"] });
  });
  it("keeps answers isolated while switching sessions and removes drafts on purge", () => {
    const state = createSessionInteractions();
    state.update("a", { questionDrafts: { request: toggleQuestionChoice(emptyQuestionDraft, question, 0) } });
    state.update("b", { questionDrafts: { request: toggleQuestionChoice(emptyQuestionDraft, question, 1) } });
    expect(questionDraftAnswers([question], state.get("a").questionDrafts.request)).toEqual({ "0": ["2048"] });
    expect(questionDraftAnswers([question], state.get("b").questionDrafts.request)).toEqual({ "0": ["扫雷"] });
    state.forget("a"); expect(state.get("a").questionDrafts).toEqual({});
    expect(state.get("b").questionDrafts.request.selections).toEqual({ "0": [1] });
  });
  it("does not offer unsupported custom input and locks all controls during submission", () => {
    const markup = renderToStaticMarkup(createElement(TranscriptItem, { runtimeId: "kimi-code", workspace: null, onApprove: () => {}, approvalBusy: true,
      entry: { id: "question", kind: "approval", runId: "run", at: "2026-09-27T00:00:00Z", text: "", approval: { ...approval, questions: [{ ...question, allowCustom: false }] } } }));
    expect(markup).not.toContain("其他"); expect(markup).toContain('<fieldset class="agent-question__field" disabled=""');
    expect(markup).toContain("正在提交…");
  });
  it("renders bridged Kimi Other as one choice with a required text draft, not a separate question", () => {
    const questions = kimiFormQuestions({ mode: "form", message: "游戏？", requestedSchema: { type: "object", properties: {
      q0: { type: "string", title: "类型", oneOf: [{ const: "2048" }, { const: "扫雷" }, { const: "other-marker", title: "Other" }] },
      q0_other: { type: "string", title: "Other" },
    } }, _meta: { agentLabKimiOther: { version: 1, fields: [{ id: "q0", fieldId: "q0_other", value: "other-marker" }] } } });
    const draft = toggleQuestionChoice(emptyQuestionDraft, questions[0], questions[0].options.length);
    const render = (questionDraft: typeof draft): string => renderToStaticMarkup(createElement(TranscriptItem, {
      runtimeId: "kimi-code", workspace: "/workspace", onApprove: () => {}, approvalBusy: false, questionDraft,
      entry: { id: "question", kind: "approval", runId: "run", at: "2026-09-27T00:00:00Z", text: "", approval: { ...approval, questions } },
    }));
    const empty = render(draft);
    expect(empty.match(/<fieldset /g)).toHaveLength(1);
    expect(empty).toContain("其他"); expect(empty).toContain("<textarea");
    expect(empty).toContain('type="submit" disabled=""'); expect(empty).not.toContain("other-marker");
    const filled = { ...draft, customText: { q0: "象棋" } };
    expect(render(filled)).not.toContain('type="submit" disabled=""');
    expect(questionDraftAnswers(questions, filled)).toEqual({ q0: ["象棋"] });
  });
});
