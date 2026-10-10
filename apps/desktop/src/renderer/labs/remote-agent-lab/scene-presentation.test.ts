import { describe, expect, it } from "vitest";
import { browserFrame, browserReconnectOptions, desktopInputEnabled, followBrowserTab, observerLabel, remoteCommandItems } from "./scene-presentation";
import type { RemoteItem } from "../../../../../../packages/contracts/src/remote-agent";

describe("remote scene presentation", () => {
  it("follows new/remaining pages but never steals selection because CDP reordered its rows", () => {
    const tabs = [{ targetId: "blank", url: "about:blank", title: "" }, { targetId: "page", url: "https://example.com", title: "example" }];
    expect(followBrowserTab(new Set(["blank"]), tabs, "blank")).toBe("page");
    expect(followBrowserTab(new Set(["blank", "page"]), [...tabs].reverse(), "blank")).toBeUndefined();
    expect(followBrowserTab(new Set(["blank", "page"]), [tabs[1]], "blank")).toBe("page");
  });
  it("never labels an in-progress connection as disconnected", () => {
    expect(observerLabel("loading", false, false)).toContain("正在连接");
    expect(observerLabel("connected", false, true)).toContain("人工接管");
    expect(observerLabel("error", false, false)).toContain("已断开");
  });
  it("reconnects only to a still-current target, without replaying closed page IDs", () => {
    const tabs = [{ targetId: "current", url: "about:blank", title: "" }];
    expect(browserReconnectOptions(tabs, "current", false)).toEqual({ targetId: "current" });
    expect(browserReconnectOptions(tabs, "closed", false)).toEqual({});
    expect(browserReconnectOptions([], "closed", false)).toBeUndefined();
    expect(browserReconnectOptions([], "closed", true)).toEqual({});
  });
  it("enables desktop input only for an explicit live control grant, never an observer", () => {
    expect(desktopInputEnabled(true, true, "connected", false, false)).toBe(true);
    expect(desktopInputEnabled(false, true, "connected", false, false)).toBe(false);
    expect(desktopInputEnabled(true, false, "connected", false, false)).toBe(false);
    expect(desktopInputEnabled(true, true, "loading", false, false)).toBe(false);
    expect(desktopInputEnabled(true, true, "error", false, false)).toBe(false);
    expect(desktopInputEnabled(true, true, "connected", true, false)).toBe(false);
    expect(desktopInputEnabled(true, true, "connected", false, true)).toBe(false);
  });
  it("keeps command/fs query receipts but not unrelated edits/browser tools", () => {
    const items = ["exec", "terminal", "openclaw:exec", "exec_command", "ls", "grep", "process", "browser", "write", "read", "request_user_input"].map(name => ({ id: name, role: "tool", text: "", tool: { name, title: name, input: "", status: "completed" } })) as RemoteItem[];
    expect(remoteCommandItems(items).map(item => item.id)).toEqual(["exec", "terminal", "openclaw:exec", "exec_command", "ls", "grep", "process"]);
  });
  it("validates the native big-endian metadata + JPEG frame, not just a ready message", () => {
    const meta = new TextEncoder().encode(JSON.stringify({ url: "https://example.com" })), jpeg = new Uint8Array([255, 216, 12, 255, 217]);
    const packet = new Uint8Array(4 + meta.length + jpeg.length); new DataView(packet.buffer).setUint32(0, meta.length); packet.set(meta, 4); packet.set(jpeg, 4 + meta.length);
    expect(browserFrame(packet.buffer)).toEqual({ url: "https://example.com", jpeg });
    for (const invalid of [new ArrayBuffer(0), new ArrayBuffer(5), packet.slice(0, 7).buffer]) expect(() => browserFrame(invalid)).toThrow();
    packet[4 + meta.length] = 0; expect(() => browserFrame(packet.buffer)).toThrow("格式异常");
  });
});
