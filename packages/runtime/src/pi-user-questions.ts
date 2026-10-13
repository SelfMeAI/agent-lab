import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentQuestion, AgentQuestionAnswers, ApprovalRequest } from "../../contracts/src/index";
import { piQuestions, validateQuestionAnswers } from "./user-questions";

const parameters = Type.Object({
  questions: Type.Array(Type.Object({
    id: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$", description: "Unique, stable question ID." }),
    header: Type.Optional(Type.String({ maxLength: 12, description: "Short category label." })),
    question: Type.String({ minLength: 1, maxLength: 2000, description: "The actual question to ask the user." }),
    detail: Type.Optional(Type.String({ maxLength: 2000, description: "Additional context if necessary." })),
    options: Type.Optional(Type.Array(Type.Object({
      label: Type.String({ minLength: 1, maxLength: 200 }),
      description: Type.Optional(Type.String({ maxLength: 2000 })),
    }, { additionalProperties: false }), { maxItems: 4, description: "Meaningful choices. Omit for free-text input. Do not add Other; the UI adds it." })),
    multi_select: Type.Optional(Type.Boolean({ description: "Allow multiple choices; otherwise single-select." })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 4 }),
}, { additionalProperties: false });

interface PendingQuestion {
  request: ApprovalRequest;
  finish(answers: AgentQuestionAnswers | null, expired: boolean): void;
}

/** App-owned Pi SDK custom tool. Pi still owns validation, execution and its loop. */
export class PiUserQuestions {
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(private readonly onRequest: (request: ApprovalRequest) => void,
    private readonly onExpire: (request: ApprovalRequest) => void) {}

  get isPending(): boolean { return this.pending.size > 0; }

  tool(): ToolDefinition<typeof parameters, { type: "agentLabUserQuestions"; summary: string }> {
    return {
      name: "ask_user_question", label: "向你提问", executionMode: "sequential",
      description: "Agent Lab user-question extension for Pi. Ask the user when a choice or clarification is needed before proceeding. Supports 1-4 questions, single/multiple choices and free-text Other. Never invent a user's answer. Do not add an Other option yourself. Cancellation is not consent or permission to perform an operation.",
      promptSnippet: "Ask the user for necessary choices or clarification using the desktop question card",
      parameters,
      execute: async (toolCallId, params, signal) => {
        const questions = piQuestions(params.questions);
        if (!questions.length) throw new Error("提问内容无效：请检查问题 ID、问题内容及选项");
        const answers = await this.ask(toolCallId, questions, signal);
        const summary = answers ? questions.map(q => `${q.header || q.question}：${answers[q.id].join("、")}`).join("\n") : "已取消回答";
        return { content: [{ type: "text", text: JSON.stringify({ answers: answers ?? {}, cancelled: answers === null }) }],
          details: { type: "agentLabUserQuestions", summary } };
      },
    };
  }

  /** Return false for non-question IDs so ordinary permission handling stays separate. */
  respond(requestId: string | number, optionId: string, value?: AgentQuestionAnswers): boolean {
    const pending = this.pending.get(String(requestId));
    if (!pending) return false;
    if (optionId !== "submit" && optionId !== "cancel") throw new Error("无效的提问选项");
    const answers = optionId === "submit" ? validateQuestionAnswers(pending.request.questions!, value) : null;
    if (answers && pending.request.questions!.some(q => answers[q.id].filter(value => !q.options.some(o => o.label === value)).length > 1)) {
      throw new Error("每个问题只能填写一个自定义答案");
    }
    pending.finish(answers, false);
    return true;
  }

  cancelAll(): void { for (const pending of [...this.pending.values()]) pending.finish(null, true); }

  private ask(toolCallId: string, questions: AgentQuestion[], signal?: AbortSignal): Promise<AgentQuestionAnswers | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const requestId = randomUUID();
    const request: ApprovalRequest = { requestId, title: "需要你回答", toolCallId, questions, options: [
      { optionId: "submit", name: "提交答案", kind: "allow_once" },
      { optionId: "cancel", name: "取消回答", kind: "reject_once" },
    ] };
    return new Promise(resolve => {
      let settled = false;
      const finish = (answers: AgentQuestionAnswers | null, expired: boolean): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        this.pending.delete(requestId);
        if (expired) this.onExpire(request);
        resolve(answers);
      };
      const abort = (): void => finish(null, true);
      this.pending.set(requestId, { request, finish });
      signal?.addEventListener("abort", abort, { once: true });
      this.onRequest(request);
    });
  }
}
