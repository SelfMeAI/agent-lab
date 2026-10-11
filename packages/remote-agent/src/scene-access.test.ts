import { describe, expect, it } from "vitest";
import { activeBrowserAction, SceneActivity, sceneAccess, toolIdentity, toolResource } from "../../../services/remote-agent/openclaw/plugin/scene-access";

describe("remote scene input admission", () => {
  it("locks only the matching resource, not model thinking or an entire turn", () => {
    expect(sceneAccess(true, undefined, "owner", "task")).toEqual({ agentBusy: true, humanControl: false, inputAllowed: true, browserBusy: false, terminalBusy: false, browserInputAllowed: true, terminalInputAllowed: true, takeover: "none" });
    expect(sceneAccess(true, undefined, "owner", "task", true, false)).toMatchObject({ inputAllowed: true, browserInputAllowed: false, terminalInputAllowed: true });
    expect(sceneAccess(true, undefined, "owner", "task", false, true)).toMatchObject({ inputAllowed: true, browserInputAllowed: true, terminalInputAllowed: false });
  });
  it("keeps all views readonly until takeover is ready, and fences other owners/tasks", () => {
    const hold = { owner: "owner", task: "task", ready: false, stopping: false };
    expect(sceneAccess(true, hold, "owner", "task")).toMatchObject({ humanControl: false, inputAllowed: false, browserInputAllowed: false, terminalInputAllowed: false, takeover: "waiting" });
    hold.stopping = true; expect(sceneAccess(true, hold, "owner", "task").takeover).toBe("stopping");
    hold.ready = true;
    expect(sceneAccess(true, hold, "owner", "task")).toMatchObject({ humanControl: true, inputAllowed: true, browserInputAllowed: true, terminalInputAllowed: true, takeover: "ready" });
    for (const [owner, task] of [["other", "task"], ["owner", "other"]]) expect(sceneAccess(false, hold, owner, task)).toMatchObject({ humanControl: false, inputAllowed: false, takeover: "none" });
  });
  it("does not revoke ordinary desktop grants just because a turn starts", () => {
    const activity = new SceneActivity(), grant = activity.grant();
    activity.observe({ runId: "a", stream: "lifecycle", data: { phase: "start" } });
    expect(grant.signal.aborted).toBe(false); expect(activity.busy(0)).toBe(true);
    activity.beginTool("a:call", "a", "browser"); activity.beginTool("b:call", "b", "terminal");
    activity.observe({ runId: "a", stream: "lifecycle", data: { phase: "error" } });
    expect(activity.occupied("browser")).toBe(false); expect(activity.occupied("terminal")).toBe(true);
    activity.observe({ runId: "b", stream: "tool", data: { phase: "result", toolCallId: "call" } });
    expect(activity.pending).toBe(false); expect(activity.busy(1)).toBe(true); expect(activity.busy(0)).toBe(false);
    activity.revoke(); expect(grant.signal.aborted).toBe(true);
  });
  it("drains admitted human inputs for the matching resource only", async () => {
    const activity = new SceneActivity(); let finish!: () => void;
    activity.track(new Promise<void>(resolve => { finish = resolve; }), "browser");
    await activity.drain("terminal"); let drained = false;
    const waiting = activity.drain("browser").then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); expect(activity.pending).toBe(true);
    finish(); await waiting; expect(activity.pending).toBe(false);
    const grant = activity.grant(); activity.dispose(); expect(grant.signal.aborted).toBe(true);
  });
  it("retains the same pending call until release and cancels waiting on the native signal", async () => {
    const activity = new SceneActivity(); let held = true, calls = 0;
    const signal = new AbortController();
    const waiting = activity.waitUntil(() => !held, signal.signal).then(() => { calls++; });
    activity.changed(); await Promise.resolve(); expect(calls).toBe(0);
    held = false; activity.changed(); await waiting; expect(calls).toBe(1);
    held = true; const canceled = activity.waitUntil(() => !held, signal.signal);
    signal.abort(new Error("native round ended")); await expect(canceled).rejects.toThrow("native round ended");
    held = false; activity.changed(); expect(calls).toBe(1);
    expect(() => activity.waitUntil(() => true, signal.signal)).toThrow("native round ended");
  });
  it("tracks concurrent calls until each operation completes, including non-browser tools", () => {
    const activity = new SceneActivity();
    activity.beginTool("run:one", "run", "terminal"); activity.beginTool("run:two", "run", "terminal");
    activity.endTool("run:one"); expect(activity.occupied("terminal")).toBe(true);
    activity.endTool("run:two"); expect(activity.pending).toBe(false);
    activity.beginTool("run:read", "run"); expect(activity.pending).toBe(true);
    activity.observe({ runId: "run", stream: "lifecycle", data: { phase: "end" } }); expect(activity.pending).toBe(false);
    expect(toolResource("browser")).toBe("browser"); expect(toolResource("process")).toBe("terminal");
    expect(toolResource("exec", "code_mode_exec")).toBeUndefined();
    expect(toolIdentity({ toolName: "exec" }, { runId: "run", toolCallId: "id" })).toBe("run:id");
  });
  it("does not foreground browser polling, screenshots or passive observation", () => {
    for (const action of ["status", "tabs", "snapshot", "screenshot"]) expect(activeBrowserAction("browser", { action })).toBe(false);
    for (const action of ["open", "navigate", "focus"]) expect(activeBrowserAction("browser", { action })).toBe(true);
    expect(activeBrowserAction("browser", { action: "act", request: { kind: "click" } })).toBe(true);
    expect(activeBrowserAction("browser", { action: "act", request: { kind: "wait" } })).toBe(false);
    expect(activeBrowserAction("other", { action: "open" })).toBe(false);
  });
});
