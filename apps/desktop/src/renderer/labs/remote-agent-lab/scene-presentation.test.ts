import { describe, expect, it } from "vitest";
import { desktopInputEnabled, observerLabel, remoteSceneTabs } from "./scene-presentation";

describe("remote scene presentation", () => {
  it("keeps only the agreed views for each engine", () => {
    expect(remoteSceneTabs("openclaw")).toEqual(["desktop", "terminal", "files", "preview"]);
    expect(remoteSceneTabs("openhands")).toEqual(["browser", "files", "preview"]);
  });
  it("describes connection and actual input permission without a takeover state", () => {
    expect(observerLabel("loading", false)).toContain("正在连接");
    expect(observerLabel("connected", true)).toBe("LIVE · 可操作");
    expect(observerLabel("connected", false)).toBe("LIVE · 只读观察");
    expect(observerLabel("error", true)).toBe("画面连接已断开");
  });
  it("accepts desktop input only in the active, connected, authorized view", () => {
    expect(desktopInputEnabled(true, true, "connected")).toBe(true);
    expect(desktopInputEnabled(false, true, "connected")).toBe(false);
    expect(desktopInputEnabled(true, false, "connected")).toBe(false);
    expect(desktopInputEnabled(true, true, "loading")).toBe(false);
    expect(desktopInputEnabled(true, true, "error")).toBe(false);
  });
});
