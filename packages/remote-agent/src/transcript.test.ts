import { describe, expect, it } from "vitest";
import { actionTitle, applyOpenHandsEvent, contentText, executionFailure, openClawMessage, openHandsItem, taskStatus, timestamp, toolDiff, toolInput } from "./transcript";

describe("remote native transcript projection", () => {
  it("projects actual user text without forwarding native secrets/config", () => {
    const item = openHandsItem({ id: "user", kind: "MessageEvent", source: "user", timestamp: "2026-10-10T03:00:00", llm_message: { role: "user", content: [{ type: "text", text: "你好" }] }, agent_settings: { api_key: "private" } });
    expect(item).toEqual({ id: "user", at: "2026-10-10T03:00:00.000Z", role: "user", text: "你好", reasoning: undefined });
    expect(JSON.stringify(item)).not.toContain("private");
  });
  it("ignores full state, system prompts and unseen native event kinds", () => {
    for (const kind of ["SystemPromptEvent", "ConversationStateUpdateEvent", "UnrecognizedEvent"]) expect(openHandsItem({ id: kind, kind, value: { api_key: "secret" } })).toBeUndefined();
    expect(openHandsItem({ kind: "MessageEvent" })).toBeUndefined();
  });
  it("does not present raw file-editor JSON as a human title", () => {
    expect(actionTitle("file_editor", { command: "create", path: "/workspace/proof.txt" }, 'file_editor: {"command":"create"}')).toBe("创建文件 · proof.txt");
    expect(actionTitle("file_editor", { command: "view", path: "proof.txt" })).toBe("读取文件 · proof.txt");
    expect(actionTitle("exec", { command: "pwd" }, "Inspect work directory")).toBe("Inspect work directory");
  });
  it("shows file paths/content rather than an opaque operation verb", () => {
    expect(toolInput({ command: "create", path: "proof.txt", file_text: "OK" })).toBe("proof.txt\nOK");
    expect(toolInput({ command: "view", path: "proof.txt" })).toBe("proof.txt");
    expect(toolInput({ command: "pwd" })).toBe("pwd");
    expect(toolInput({ api_key: "hidden", token: "hidden", password: "hidden", query: "visible" })).toBe("query: visible");
  });
  it("renders green/red-ready patches for native creation and edit schemas", () => {
    expect(toolDiff({ command: "create", path: "x", file_text: "new\n" })).toContain("+new");
    expect(toolDiff({ path: "x", old_str: "old\n", new_str: "new\n" })).toContain("-old\n+new");
    expect(toolDiff({ path: "x", old_string: "old\n", new_string: "new\n" })).toContain("-old\n+new");
    expect(toolDiff({ path: "x", old_content: "old\n", new_content: "new\n" })).toContain("-old\n+new");
    expect(toolDiff({ path: "x", prev_exist: false, new_content: "new" })).toContain("+new");
    expect(toolDiff({ path: "x", content: "replacement with unknown previous content" })).toBeUndefined();
    expect(toolDiff({ path: "x" })).toBeUndefined();
  });
  it("correlates observations and native rejection with the existing action", () => {
    let items = applyOpenHandsEvent([], { id: "action", kind: "ActionEvent", tool_name: "file_editor", action: { command: "create", path: "x", file_text: "OK" }, timestamp: "2026-10-10T03:00:00Z" });
    items = applyOpenHandsEvent(items, { id: "result", kind: "ObservationEvent", action_id: "action", timestamp: "2026-10-10T03:00:01Z", observation: { content: [{ text: "Created" }], is_error: false } });
    expect(items).toHaveLength(1); expect(items[0].tool).toMatchObject({ status: "completed", output: "Created", endedAt: "2026-10-10T03:00:01.000Z" });
    items = applyOpenHandsEvent(items, { id: "reject", kind: "UserRejectObservation", action_id: "action", observation: { content: "Declined" } });
    expect(items[0].tool?.status).toBe("rejected");
  });
  it("deduplicates durable events, replacing a partial stream", () => {
    const initial = [{ id: "msg", role: "assistant" as const, text: "partial", streaming: true }];
    const event = { id: "msg", kind: "MessageEvent", llm_message: { role: "assistant", content: [{ type: "text", text: "complete" }] } };
    const items = applyOpenHandsEvent(initial, event);
    expect(applyOpenHandsEvent(items, event)).toHaveLength(1); expect(items[0]).toMatchObject({ text: "complete", streaming: false });
  });
  it("ties native tool errors to their call without declaring the whole run failed", () => {
    const items = applyOpenHandsEvent([], { id: "action", kind: "ActionEvent", tool_name: "terminal", tool_call_id: "call", action: { command: "pwd" } });
    const result = applyOpenHandsEvent(items, { id: "failure", kind: "AgentErrorEvent", tool_call_id: "call", error: "Command validation failed" });
    expect(result).toHaveLength(1); expect(result[0].tool).toMatchObject({ status: "failed", output: "Command validation failed" });
    expect(taskStatus("stuck")).toBe("error");
  });
  it("separates OpenClaw thinking and failed tool results from regular text", () => {
    const item = openClawMessage({ role: "assistant", content: [{ type: "thinking", thinking: "reason" }, { type: "text", text: "answer" }] }, "id");
    expect(item).toMatchObject({ text: "answer", reasoning: "reason", role: "assistant" });
    expect(openClawMessage({ role: "toolResult", toolName: "exec", isError: true, content: [{ text: "Failed" }] }, "tool")?.tool).toMatchObject({ status: "failed", output: "Failed" });
    expect(openClawMessage({ role: "system", content: "secret" }, "system")).toBeUndefined();
  });
  it("uses truthful native status/date and tolerates missing content", () => {
    expect(taskStatus("awaiting_user_confirmation")).toBe("waiting"); expect(taskStatus("finished")).toBe("completed");
    expect(taskStatus("paused")).toBe("paused"); expect(taskStatus("unknown")).toBe("idle");
    expect(timestamp("not-a-date")).toBeUndefined(); expect(timestamp(Number.MAX_VALUE)).toBeUndefined(); expect(contentText({ secret: "not text" })).toBe("");
  });
  it("keeps durable OpenClaw execution errors even without visible assistant text", () => {
    const failure = openClawMessage({ id: "native-error", timestamp: "2026-10-10T04:17:39Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Provider returned an incomplete or malformed tool call", __openclaw: { runId: "failed-run" } } }, "fallback");
    expect(failure).toMatchObject({ id: "native-error", text: "", failure: { message: "Provider returned an incomplete or malformed tool call", runId: "failed-run", at: "2026-10-10T04:17:39.000Z" } });
    expect(openClawMessage({ role: "assistant", stopReason: "error", errorMessage: "Failed", content: [{ text: "Failed" }] }, "error")?.text).toBe("");
    expect(openClawMessage({ role: "assistant", stopReason: "error", errorMessage: "Failed", content: [{ text: "Already created the file" }] }, "error")?.text).toBe("Already created the file");
    expect(openClawMessage({ role: "user", stopReason: "error", content: "Quoted error" }, "user")?.failure).toBeUndefined();
  });
  it("projects fatal OpenHands errors separately from recoverable tool failures", () => {
    const item = openHandsItem({ id: "fatal", kind: "ConversationErrorEvent", detail: "API Error: 524", timestamp: "2026-10-10T04:00:00Z" });
    expect(item).toMatchObject({ role: "notice", text: "", failure: { message: "API Error: 524", at: "2026-10-10T04:00:00.000Z" } });
    expect(openHandsItem({ id: "tool", kind: "AgentErrorEvent", error: "Tool failed" })?.failure).toBeUndefined();
  });
  it("does not leak credential-shaped fields in failure details", () => {
    const failure = executionFailure('API key sk-fixture-private-secret authorization=BearerValue token="sensitive" password=hidden Bearer secret-auth-value');
    expect(failure.message).not.toContain("fixture-private"); expect(failure.message).not.toContain("sensitive"); expect(failure.message).not.toContain("secret-auth-value"); expect(failure.message).not.toContain("BearerValue");
  });
});
