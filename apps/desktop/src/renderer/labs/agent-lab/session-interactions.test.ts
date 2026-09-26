import { describe, expect, it } from "vitest";
import { createSessionInteractions } from "./session-interactions";

describe("session-scoped workspace interaction", () => {
  it("keeps drafts and in-flight controls independent while switching sessions", () => {
    const state = createSessionInteractions();
    state.update("a", { prompt: "A 草稿", submitting: true, stopping: true, approvalBusy: true });
    state.update("b", { prompt: "B 草稿", connecting: true });
    expect(state.get("b")).toMatchObject({ prompt: "B 草稿", submitting: false, stopping: false, approvalBusy: false });
    state.update("a", { submitting: false, stopping: false, approvalBusy: false, error: "A 的异步错误" });
    expect(state.get("b")).toMatchObject({ prompt: "B 草稿", connecting: true, error: null });
    expect(state.get("a")).toMatchObject({ prompt: "A 草稿", error: "A 的异步错误" });
  });

  it("restores a failed submission only to its original draft and preserves newly typed text", () => {
    const state = createSessionInteractions();
    state.update("a", { prompt: "", submitting: true });
    state.update("b", { prompt: "其他会话的内容" });
    state.update("a", current => ({ prompt: current.prompt || "发送失败的原消息", submitting: false }));
    expect(state.get("a").prompt).toBe("发送失败的原消息");
    expect(state.get("b").prompt).toBe("其他会话的内容");
    state.update("a", { prompt: "刚写的补充" });
    state.update("a", current => ({ prompt: current.prompt || "原消息" }));
    expect(state.get("a").prompt).toBe("刚写的补充");
    state.forget("a");
    expect(state.get("a").prompt).toBe("");
    expect(state.get("b").prompt).toBe("其他会话的内容");
  });
});
