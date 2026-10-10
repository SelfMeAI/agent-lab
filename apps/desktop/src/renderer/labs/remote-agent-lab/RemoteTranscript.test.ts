import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteQuestion } from "../../../../../../packages/contracts/src/remote-agent";
import { remoteQuestionAnswers, RemoteFailureCard, RemoteTranscriptItem } from "./RemoteTranscript";

const question: RemoteQuestion = { id: "native-question", questions: [{ id: "choice", title: "方案", prompt: "请选择方案", options: [{ label: "A" }, { label: "B" }], multiple: false, other: true, secret: false }] };
describe("remote native user-facing trajectory", () => {
  it("uses Other as a replacement for a single selection, not an invalid second answer", () => {
    expect(remoteQuestionAnswers(question, { choice: ["A"] }, { choice: "我的方案" })).toEqual({ choice: ["我的方案"] });
    expect(remoteQuestionAnswers({ ...question, questions: [{ ...question.questions[0], multiple: true }] }, { choice: ["A"] }, { choice: "我的方案" })).toEqual({ choice: ["A", "我的方案"] });
  });
  it("renders native approval choices and actual tool diffs without raw JSON cards", () => {
    const html = renderToStaticMarkup(createElement(RemoteTranscriptItem, { item: { id: "tool", role: "tool", text: "", tool: { name: "edit", title: "编辑文件 · proof.txt", input: "proof.txt", status: "completed", diff: "-old\n+new" } }, engine: "openclaw", busy: false, onApproval() {}, onAnswer() {} }));
    expect(html).toContain("编辑文件"); expect(html).toContain("is-added"); expect(html).toContain("is-removed"); expect(html).not.toContain("执行中");
    const approval = renderToStaticMarkup(createElement(RemoteTranscriptItem, { item: { id: "approval", role: "notice", text: "", approval: { id: "request", title: "允许命令？", detail: "pwd", canAlways: true } }, engine: "openhands", busy: false, onApproval() {}, onAnswer() {} }));
    expect(approval).toContain("本任务始终允许"); expect(approval).toContain("允许一次"); expect(approval).toContain("拒绝");
  });
  it("keeps failed-turn reasons in history, offering actions only for the current interruption", () => {
    const props = { item: { id: "failure", role: "assistant" as const, text: "已创建文件", failure: { message: "Provider returned an incomplete or malformed tool call", at: "2026-10-10T04:17:39Z" } }, engine: "openclaw" as const, busy: false, onApproval() {}, onAnswer() {} };
    const historical = renderToStaticMarkup(createElement(RemoteTranscriptItem, props));
    expect(historical).toContain("已创建文件"); expect(historical).toContain("本轮执行中断"); expect(historical).toContain("工具调用不完整"); expect(historical).toContain("错误详情"); expect(historical).toContain("Provider returned"); expect(historical).not.toContain("继续任务"); expect(historical).not.toContain("重新连接");
    const active = renderToStaticMarkup(createElement(RemoteTranscriptItem, { ...props, recovery: { disabled: false, continueDisabled: false, onContinue() {}, onCompose() {} } }));
    expect(active).toContain("继续任务"); expect(active).toContain("补充要求"); expect(active).toContain("已有对话和文件保留"); expect(active).not.toContain("disabled=");
  });
  it("disables conflicting recovery actions while preserving the reason and context", () => {
    const props = { failure: { message: "API Error: 524" }, recovery: { disabled: true, continueDisabled: false, onContinue() {}, onCompose() {} } };
    const busy = renderToStaticMarkup(createElement(RemoteFailureCard, props));
    expect(busy.match(/disabled=""/g)).toHaveLength(2); expect(busy).toContain("超时");
    const draft = renderToStaticMarkup(createElement(RemoteFailureCard, { ...props, recovery: { ...props.recovery, disabled: false, continueDisabled: true } }));
    expect(draft.match(/disabled=""/g)).toHaveLength(1); expect(draft).toContain("待发送内容");
    const unknown = renderToStaticMarkup(createElement(RemoteFailureCard, { failure: { message: "" } }));
    expect(unknown).toContain("暂时无法读取具体原因"); expect(unknown).not.toContain("错误详情");
  });
});
