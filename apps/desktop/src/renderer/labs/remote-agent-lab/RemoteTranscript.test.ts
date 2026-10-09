import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RemoteQuestion } from "../../../../../../packages/contracts/src/remote-agent";
import { remoteQuestionAnswers, RemoteTranscriptItem } from "./RemoteTranscript";

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
});
