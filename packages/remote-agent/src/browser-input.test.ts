import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserInputChannel, browserInputCommands, browserInputEndpoint } from "../../../services/remote-agent/openclaw/plugin/browser-input";

afterEach(() => vi.unstubAllGlobals());
describe("closed human browser input transport", () => {
  it("allows mouse, key, Unicode text and release, never arbitrary CDP/script payloads", () => {
    expect(browserInputCommands([{ kind: "mouse", type: "down", x: 10, y: 20, button: "left", buttons: 1 }, { kind: "key", type: "down", key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 }, { kind: "text", text: "你好" }, { kind: "release" }])).toMatchObject([{ method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 10, y: 20 } }, { method: "Input.dispatchKeyEvent", params: { type: "keyDown" } }, { method: "Input.insertText", params: { text: "你好" } }, null]);
    for (const input of [[], new Array(65).fill({ kind: "release" }), [{ kind: "evaluate", fn: "danger" }], [{ kind: "mouse", type: "down", x: NaN, y: 0 }], [{ kind: "text", text: "x".repeat(32_001) }], [{ kind: "key", type: "down", key: "a", code: "KeyA", keyCode: 65, modifiers: 32 }]]) expect(() => browserInputCommands(input)).toThrow();
    expect(browserInputCommands([{ kind: "text", text: "safe", method: "Runtime.evaluate", params: { expression: "unsafe" } }])).toEqual([{ method: "Input.insertText", params: { text: "safe" } }]);
  });
  it("accepts only the exact native page on the managed container-local CDP endpoint", () => {
    const target = { id: "owned", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/owned" };
    expect(browserInputEndpoint("http://127.0.0.1:18800", "owned", target)).toBe(target.webSocketDebuggerUrl);
    for (const endpoint of ["ws://example.com:18800/devtools/page/owned", "ws://127.0.0.1:18801/devtools/page/owned", "ws://127.0.0.1:18800/devtools/browser/owned", "ws://127.0.0.1:18800/devtools/page/another", "ws://user:secret@127.0.0.1:18800/devtools/page/owned"]) expect(() => browserInputEndpoint("http://127.0.0.1:18800", "owned", { ...target, webSocketDebuggerUrl: endpoint })).toThrow();
    expect(() => browserInputEndpoint("http://example.com:18800", "owned", target)).toThrow();
  });
  it("performs Enter's editing action without inserting text for shortcut combinations", () => {
    const event = { kind: "key", type: "down", key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 };
    expect(browserInputCommands([event])[0]?.params.text).toBe("\r");
    expect(browserInputCommands([{ ...event, modifiers: 8 }])[0]?.params.text).toBe("\r");
    expect(browserInputCommands([{ ...event, modifiers: 2 }])[0]?.params.text).toBeUndefined();
    expect(browserInputCommands([{ ...event, type: "up" }])[0]?.params.text).toBeUndefined();
  });
  it("rechecks a lease per event and releases held input when authority is revoked", async () => {
    const sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
    class FakeSocket extends EventTarget {
      static OPEN = 1; readyState = 1;
      constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      send(value: string) { const request = JSON.parse(value); sent.push(request); queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: request.id, result: {} }) }))); }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const channel = new BrowserInputChannel("ws://127.0.0.1:18800/devtools/page/owned");
    let admitted = true;
    const authorize = () => { if (!admitted) throw new Error("revoked"); };
    await channel.input(browserInputCommands([{ kind: "key", type: "down", key: "Shift", code: "ShiftLeft", keyCode: 16, modifiers: 8 }, { kind: "mouse", type: "down", x: 10, y: 20, button: "left", buttons: 1 }]), authorize);
    admitted = false;
    await expect(channel.input(browserInputCommands([{ kind: "text", text: "must not arrive" }]), authorize)).rejects.toThrow("revoked");
    channel.close();
    expect(sent.map(call => call.params.type)).toEqual(["keyDown", "mousePressed", "keyUp", "mouseReleased"]);
    expect(sent.some(call => call.method === "Input.insertText")).toBe(false);
    expect(channel.closed).toBe(true);
  });
});
