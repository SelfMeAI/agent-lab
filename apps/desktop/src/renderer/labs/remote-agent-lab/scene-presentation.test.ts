import { describe, expect, it } from "vitest";
import { desktopInputEnabled, observerLabel, remoteSceneTabs, sceneTabDescription, terminalConnectionNotice } from "./scene-presentation";

describe("remote scene presentation", () => {
  it("keeps only the agreed views for each engine", () => {
    expect(remoteSceneTabs("openclaw")).toEqual(["desktop", "terminal", "files", "preview"]);
    expect(remoteSceneTabs("openhands")).toEqual(["browser", "files", "preview"]);
  });
  it("describes connection and actual input permission without a takeover state", () => {
    expect(observerLabel("loading", false)).toContain("正在连接");
    expect(observerLabel("connected", true)).toBe("可操作");
    expect(observerLabel("connected", false)).toBe("只读观察");
    expect(observerLabel("error", true)).toBe("画面连接已断开");
  });
  it("accepts desktop input only in the active, connected, authorized view", () => {
    expect(desktopInputEnabled(true, true, "connected")).toBe(true);
    expect(desktopInputEnabled(false, true, "connected")).toBe(false);
    expect(desktopInputEnabled(true, false, "connected")).toBe(false);
    expect(desktopInputEnabled(true, true, "loading")).toBe(false);
    expect(desktopInputEnabled(true, true, "error")).toBe(false);
  });
  it("moves stable view explanations into the appropriate tab tooltip", () => {
    expect(sceneTabDescription("openclaw", "terminal")).toBe("与桌面终端共用会话");
    expect(sceneTabDescription("openhands", "browser")).toContain("只读观察");
    expect(sceneTabDescription("openhands", "terminal")).toBeUndefined();
    expect(sceneTabDescription("openclaw", "files")).toBeUndefined();
  });
  it("keeps normal terminal input clean and does not duplicate its native busy warning", () => {
    const state = { connecting: false, connected: true, ended: false, error: "", accessError: "" };
    expect(terminalConnectionNotice({ ...state, access: { busy: false, inputAllowed: true } })).toBeUndefined();
    expect(terminalConnectionNotice({ ...state, access: { busy: true, inputAllowed: false } })).toBeUndefined();
    expect(terminalConnectionNotice({ ...state, connecting: true })).toBeUndefined();
  });
  it("retains a single reconnect action for disconnected or failed terminal connections", () => {
    const state = { connecting: false, connected: false, ended: false, error: "", accessError: "" };
    expect(terminalConnectionNotice(state)).toMatchObject({ reconnect: true, message: expect.stringContaining("连接已断开") });
    expect(terminalConnectionNotice({ ...state, error: "连接失败" })).toEqual({ reconnect: true, message: "连接失败" });
    expect(terminalConnectionNotice({ ...state, connected: true, ended: true })).toMatchObject({ reconnect: true });
  });
  it("still explains unavailable input state and actual input errors without a redundant banner", () => {
    const state = { connecting: false, connected: true, ended: false, error: "", accessError: "" };
    expect(terminalConnectionNotice(state)).toEqual({ message: "正在同步输入状态…", reconnect: false });
    expect(terminalConnectionNotice({ ...state, accessError: "无法同步终端状态" })).toEqual({ message: "无法同步终端状态", reconnect: false });
    expect(terminalConnectionNotice({ ...state, error: "人工输入被拒绝", accessError: "无法同步终端状态" })).toEqual({ message: "人工输入被拒绝", reconnect: false });
  });
});
