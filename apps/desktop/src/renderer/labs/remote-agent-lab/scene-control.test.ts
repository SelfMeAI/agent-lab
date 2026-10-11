import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SceneControlDialog, sceneControlLabel, sceneInputEnabled } from "./scene-control";

describe("shared remote scene control", () => {
  const props = { busy: false, followUp: "", onFollowUp() {}, onCancel() {}, onAcquire() {}, onReturn() {} };
  it("describes one takeover for all three views, without a forced Desktop jump", () => {
    const html = renderToStaticMarkup(createElement(SceneControlDialog, { ...props, returning: false }));
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("桌面、浏览器和人工终端一起交给你操作");
    expect(html).toContain("停止并接管");
    expect(html).not.toContain("切换到桌面");
  });
  it("keeps return-with-or-without-resume explicit and explains idle versus working", () => {
    const html = renderToStaticMarkup(createElement(SceneControlDialog, { ...props, returning: true }));
    expect(html).toContain("交还控制");
    expect(html).toContain("空闲时仍可直接操作");
    expect(html).toContain("智能体工作时恢复只读");
    expect(html).toContain("交还，等待指令");
    expect(html).toContain("交还并继续");
  });
  it("permits idle input without takeover and fences busy, transition and disconnected states", () => {
    const idle = { agentBusy: false, humanControl: false, inputAllowed: true };
    expect(sceneInputEnabled(idle, true, false, false)).toBe(true);
    expect(sceneControlLabel(idle)).toBe("空闲 · 可操作");
    const working = { agentBusy: true, humanControl: false, inputAllowed: false };
    expect(sceneInputEnabled(working, true, false, false)).toBe(false);
    expect(sceneControlLabel(working)).toContain("智能体工作中");
    expect(sceneControlLabel({ ...idle, humanControl: true })).toBe("人工接管中");
    expect(sceneInputEnabled(idle, false, false, false)).toBe(false);
    expect(sceneInputEnabled(idle, true, true, false)).toBe(false);
    expect(sceneInputEnabled(idle, true, false, true)).toBe(false);
    expect(sceneInputEnabled(undefined, true, false, false)).toBe(false);
  });
});
