import { describe, expect, it } from "vitest";
import { activeBrowserAction, SceneActivity, sceneAccess } from "../../../services/remote-agent/openclaw/plugin/scene-access";

describe("remote scene input admission", () => {
  it("separates idle input from explicit exclusive takeover", () => {
    expect(sceneAccess(false, undefined, "owner", "task")).toEqual({ agentBusy: false, humanControl: false, inputAllowed: true });
    expect(sceneAccess(true, undefined, "owner", "task").inputAllowed).toBe(false);
    const hold = { owner: "owner", task: "task", ready: false };
    expect(sceneAccess(false, hold, "owner", "task")).toMatchObject({ humanControl: true, inputAllowed: false });
    hold.ready = true;
    expect(sceneAccess(false, hold, "owner", "task").inputAllowed).toBe(true);
    expect(sceneAccess(false, hold, "other", "task").inputAllowed).toBe(false);
    expect(sceneAccess(false, hold, "owner", "other").inputAllowed).toBe(false);
    expect(sceneAccess(false, undefined, "owner", "task").inputAllowed).toBe(true);
  });
  it("closes idle desktop grants before a new run and fences all sessions, including approvals", () => {
    const activity = new SceneActivity(), grant = activity.grant();
    activity.observe({ runId: "a", stream: "lifecycle", data: { phase: "start" } });
    expect(grant.signal.aborted).toBe(true); expect(activity.busy(0)).toBe(true);
    activity.observe({ runId: "a", stream: "lifecycle", data: { phase: "waiting-approval" } });
    expect(activity.busy(0)).toBe(true);
    activity.observe({ runId: "b", stream: "lifecycle", data: { phase: "start" } });
    activity.observe({ runId: "a", stream: "lifecycle", data: { phase: "error" } });
    expect(activity.busy(0)).toBe(true);
    activity.observe({ runId: "b", stream: "lifecycle", data: { phase: "end" } });
    expect(activity.busy(1)).toBe(true); expect(activity.busy(0)).toBe(false);
  });
  it("finishes admitted inputs before starting work without admitting new ones", async () => {
    const activity = new SceneActivity(); let finish!: () => void;
    activity.track(new Promise<void>(resolve => { finish = resolve; }));
    const end = activity.beginStart(); let drained = false;
    const waiting = activity.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    expect(activity.busy(0)).toBe(true); expect(activity.busy(0, false)).toBe(false);
    finish(); await waiting; end(); end(); expect(activity.busy(0)).toBe(false);
    const grant = activity.grant(); activity.dispose(); expect(grant.signal.aborted).toBe(true);
  });
  it("does not foreground browser polling, screenshots or passive observation", () => {
    for (const action of ["status", "tabs", "snapshot", "screenshot"]) expect(activeBrowserAction("browser", { action })).toBe(false);
    for (const action of ["open", "navigate", "focus"]) expect(activeBrowserAction("browser", { action })).toBe(true);
    expect(activeBrowserAction("browser", { action: "act", request: { kind: "click" } })).toBe(true);
    expect(activeBrowserAction("browser", { action: "act", request: { kind: "wait" } })).toBe(false);
    expect(activeBrowserAction("other", { action: "open" })).toBe(false);
  });
});
