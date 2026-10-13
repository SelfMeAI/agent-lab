import { describe, expect, it } from "vitest";
import type { AgentQuestionAnswers, ApprovalRequest } from "../../contracts/src/index";
import { PiAdapter } from "./pi";
import { PiUserQuestions } from "./pi-user-questions";
import { piQuestions } from "./user-questions";

const input = { questions: [
  { id: "game", header: "游戏", question: "想加哪个游戏？", options: [{ label: "2048", description: "合并" }, { label: "扫雷", description: "推理" }] },
  { id: "platform", header: "平台", question: "支持哪些平台？", multi_select: true, options: [{ label: "电脑" }, { label: "手机" }] },
] };

function setup() {
  const requests: ApprovalRequest[] = [], expired: ApprovalRequest[] = [];
  const bridge = new PiUserQuestions(request => requests.push(request), request => expired.push(request));
  const tool = bridge.tool();
  const execute = (params = input, signal?: AbortSignal) => tool.execute("call-question", params, signal, undefined, {} as Parameters<typeof tool.execute>[4]);
  return { requests, expired, bridge, tool, execute };
}

describe("Agent Lab Pi question extension", () => {
  it("uses the official custom-tool contract with explicit sequential execution", () => {
    const { tool } = setup();
    expect(tool).toMatchObject({ name: "ask_user_question", executionMode: "sequential" });
    expect(tool.description).toContain("Agent Lab");
    expect(tool.parameters.properties.questions).toMatchObject({ minItems: 1, maxItems: 4 });
  });
  it("waits for actual answers and returns single/multi/custom answers in Pi's tool result", async () => {
    const { execute, requests, bridge, expired } = setup();
    let resolved = false;
    const result = execute().then(result => { resolved = true; return result; });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ toolCallId: "call-question", questions: [{ id: "game", multiSelect: false, allowCustom: true }, { id: "platform", multiSelect: true, allowCustom: true }] });
    await Promise.resolve(); expect(resolved).toBe(false);
    const answers = { game: ["象棋"], platform: ["电脑", "主机"] };
    expect(bridge.respond(requests[0].requestId, "submit", answers)).toBe(true);
    const returned = await result;
    expect(JSON.parse((returned.content[0] as { text: string }).text)).toEqual({ answers, cancelled: false });
    expect(returned.details.summary).toBe("游戏：象棋\n平台：电脑、主机");
    expect(expired).toEqual([]); expect(bridge.isPending).toBe(false);
    expect(bridge.respond(requests[0].requestId, "submit", answers)).toBe(false);
  });
  it.each([{}, { game: [""] }, { game: ["2048", "扫雷"], platform: ["电脑"] }, { game: ["2048"], platform: ["主机", "平板"] }] as AgentQuestionAnswers[])("rejects invalid submissions without resolving the question: %j", async answers => {
    const { execute, requests, bridge } = setup();
    const result = execute();
    expect(() => bridge.respond(requests[0].requestId, "submit", answers)).toThrow();
    expect(() => bridge.respond(requests[0].requestId, "allow_session", answers)).toThrow(/提问选项/);
    expect(bridge.isPending).toBe(true);
    bridge.respond(requests[0].requestId, "cancel");
    expect(JSON.parse(((await result).content[0] as { text: string }).text)).toEqual({ answers: {}, cancelled: true });
  });
  it("supports free-text-only questions without invented choices", async () => {
    const { tool, requests, bridge } = setup();
    const result = tool.execute("call-free", { questions: [{ id: "detail", question: "补充要求？" }] }, undefined, undefined, {} as Parameters<typeof tool.execute>[4]);
    expect(requests[0].questions).toMatchObject([{ options: [], allowCustom: true }]);
    bridge.respond(requests[0].requestId, "submit", { detail: ["保持精致\n支持离线"] });
    expect(JSON.parse(((await result).content[0] as { text: string }).text).answers.detail).toEqual(["保持精致\n支持离线"]);
  });
  it.each(["abort", "stop"])("expires the card and settles the waiting tool on %s, once only", async action => {
    const { execute, requests, bridge, expired } = setup();
    const signal = new AbortController();
    const result = execute(input, signal.signal);
    if (action === "abort") signal.abort(); else bridge.cancelAll();
    bridge.cancelAll(); signal.abort();
    expect(expired).toEqual(requests); expect(bridge.isPending).toBe(false);
    expect(bridge.respond(requests[0].requestId, "submit", { game: ["扫雷"], platform: ["电脑"] })).toBe(false);
    expect((await result).details.summary).toBe("已取消回答");
  });
  it("does not open a card for a tool whose signal is already aborted", async () => {
    const { execute, requests, bridge } = setup();
    const signal = new AbortController(); signal.abort();
    expect((await execute(input, signal.signal)).details.summary).toBe("已取消回答");
    expect(requests).toEqual([]); expect(bridge.isPending).toBe(false);
  });
  it("keeps question IDs and answers isolated between Pi sessions", async () => {
    const a = setup(), b = setup();
    const first = a.execute(), second = b.execute();
    expect(b.bridge.respond(a.requests[0].requestId, "cancel")).toBe(false);
    a.bridge.cancelAll(); await first;
    expect(b.bridge.isPending).toBe(true);
    b.bridge.respond(b.requests[0].requestId, "submit", { game: ["扫雷"], platform: ["手机"] });
    expect((await second).details.summary).toContain("扫雷"); expect(b.expired).toEqual([]);
  });
  it.each([[], [{}], [{ ...input.questions[0], id: "bad id" }], [input.questions[0], input.questions[0]],
    [{ ...input.questions[0], options: [{ label: "same" }, { label: "same" }] }], Array(5).fill(input.questions[0])])("rejects malformed questions %j", value => {
    expect(piQuestions(value)).toEqual([]);
  });
  it("never treats an answer as an operation grant or a session-wide permission", async () => {
    const adapter = new PiAdapter({ homeDirectory: "unused", provider: async () => ({ baseUrl: "", model: "", apiKey: "" }) });
    const internal = adapter as unknown as { requireApproval(id: string, tool: string, detail: string): Promise<void>; allowedForSession: Set<string> };
    let request: ApprovalRequest | undefined;
    adapter.onEvent(event => { if (event.approval) request = event.approval; });
    const pending = internal.requireApproval("bash-id", "bash", "echo test");
    await expect(adapter.respondApproval(request!.requestId, "allow_session", { game: ["2048"] })).rejects.toThrow(/授权请求/);
    await expect(adapter.respondApproval(request!.requestId, "submit")).rejects.toThrow(/选项/);
    expect(internal.allowedForSession.size).toBe(0);
    await adapter.respondApproval(request!.requestId, "allow_once"); await pending;
    expect(internal.allowedForSession.size).toBe(0);
  });
});
