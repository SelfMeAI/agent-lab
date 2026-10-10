import { describe, expect, it } from "vitest";
import type { RemoteTaskSnapshot } from "../../../../../../packages/contracts/src/remote-agent";
import { activeRemoteFailure, continueRemoteTaskPrompt, remoteFailureSummary, remoteTaskLabels } from "./task-presentation";

const snapshot: RemoteTaskSnapshot = {
  task: { id: "task", title: "Task", status: "error", createdAt: "2026-10-10T03:00:00Z", updatedAt: "2026-10-10T04:00:00Z" }, connection: "connected",
  items: [{ id: "user-old", role: "user", text: "Old" }, { id: "old-failure", role: "assistant", text: "", failure: { message: "Old", runId: "old" } },
    { id: "user-new", role: "user", text: "New" }, { id: "new-failure", role: "assistant", text: "", failure: { message: "New", runId: "new" } }],
};
describe("remote interrupted-turn presentation", () => {
  it("explains the last execution, not an unusable session", () => {
    expect(remoteTaskLabels.error).toBe("本轮中断");
    expect(continueRemoteTaskPrompt).toContain("核对已有进度"); expect(continueRemoteTaskPrompt).toContain("不要重复");
  });
  it("only offers recovery on the latest native failure", () => {
    expect(activeRemoteFailure(snapshot)).toMatchObject({ itemId: "new-failure", failure: { message: "New" } });
    for (const status of ["running", "waiting", "paused", "completed", "idle"] as const) expect(activeRemoteFailure({ ...snapshot, task: { ...snapshot.task, status } })).toBeUndefined();
    expect(activeRemoteFailure()).toBeUndefined();
  });
  it("replaces the live fallback with its durable run instead of duplicating a card", () => {
    const live = { message: "Live", runId: "new" };
    const waiting = { ...snapshot, items: snapshot.items.slice(0, -1), failure: live };
    expect(activeRemoteFailure(waiting)).toEqual({ failure: live, itemId: undefined });
    expect(activeRemoteFailure({ ...waiting, items: snapshot.items })).toMatchObject({ itemId: "new-failure" });
    expect(activeRemoteFailure({ ...snapshot, failure: { message: "Later run", runId: "later" } })).toMatchObject({ itemId: undefined, failure: { runId: "later" } });
  });
  it("does not reuse an earlier turn error after a newer user message", () => {
    expect(activeRemoteFailure({ ...snapshot, items: snapshot.items.slice(0, -1) })).toEqual({ failure: { message: "", at: snapshot.task.updatedAt }, itemId: undefined });
  });
  it("uses readable reasons without falsely blaming the network or hiding unknown details", () => {
    expect(remoteFailureSummary("Provider returned an incomplete or malformed tool call")).toContain("工具调用");
    expect(remoteFailureSummary("API Error: 524")).toContain("超时");
    expect(remoteFailureSummary("429 rate limit")).toContain("繁忙");
    expect(remoteFailureSummary("401 Unauthorized")).toContain("连接配置");
    expect(remoteFailureSummary("context length exceeded")).toContain("上下文");
    expect(remoteFailureSummary("Unknown failure")).toContain("错误详情");
    expect(remoteFailureSummary("")).toContain("暂时无法读取具体原因");
  });
});
