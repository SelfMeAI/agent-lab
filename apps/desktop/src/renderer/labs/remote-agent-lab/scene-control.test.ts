import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sceneAccess } from "../../../../../../services/remote-agent/openclaw/plugin/scene-access";
import { SceneControlDialog, SceneControlWaiting, sceneControlLabel, sceneInputEnabled } from "./scene-control";

describe("shared remote scene control", () => {
  const props = { busy: false, followUp: "", onFollowUp() {}, onCancel() {}, onReturn() {} };
  it("shows confirmed waiting copy inline without hiding the preview", () => {
    const html = renderToStaticMarkup(createElement(SceneControlWaiting, { stopping: false, busy: false, onForce() {} }));
    expect(html).toContain('role="status"'); expect(html).not.toContain('aria-modal');
    expect(html).toContain("等待智能体完成当前操作");
    expect(html).toContain("智能体不会开始下一步，当前操作结束后自动交由你控制。");
    expect(html).toContain("停止并接管");
    expect(html).toContain('title="中止当前操作并接管，当前操作可能尚未完成。"');
    expect(html).not.toContain("disabled");
    const stopping = renderToStaticMarkup(createElement(SceneControlWaiting, { stopping: true, busy: false, onForce() {} }));
    expect(stopping).toContain("正在停止智能体的当前操作"); expect(stopping).toContain("disabled");
    const retry = renderToStaticMarkup(createElement(SceneControlWaiting, { stopping: true, busy: false, retry: true, onForce() {} }));
    expect(retry).not.toContain("disabled");
  });
  it("returns the original paused operation without inventing a new continue task", () => {
    const html = renderToStaticMarkup(createElement(SceneControlDialog, props));
    expect(html).toContain("交还控制");
    expect(html).toContain("暂停的操作可以继续"); expect(html).toContain("对应资源时只读");
    expect(html).not.toContain("交还并继续"); expect(html).not.toContain("交还，等待指令");
  });
  it("permits matching-resource input while model thinking and fences transitions", () => {
    const idle = sceneAccess(false, undefined, "owner", "task");
    expect(sceneInputEnabled(idle, true, false, false)).toBe(true);
    expect(sceneControlLabel(idle)).toBe("空闲 · 可操作");
    const working = sceneAccess(true, undefined, "owner", "task", true, false);
    expect(sceneInputEnabled(working, true, false, false)).toBe(true);
    expect(sceneInputEnabled(working, true, false, false, "browser")).toBe(false);
    expect(sceneInputEnabled(working, true, false, false, "terminal")).toBe(true);
    expect(sceneControlLabel(working)).toBe("智能体工作中");
    const lease = { owner: "owner", task: "task", ready: false };
    const waiting = sceneAccess(true, lease, "owner", "task");
    expect(sceneInputEnabled(waiting, true, false, false)).toBe(false); expect(sceneControlLabel(waiting)).toBe("等待智能体完成当前操作");
    lease.ready = true; expect(sceneControlLabel(sceneAccess(true, lease, "owner", "task"))).toBe("已接管 · 可操作");
    expect(sceneInputEnabled(idle, false, false, false)).toBe(false);
    expect(sceneInputEnabled(idle, true, true, false)).toBe(false);
    expect(sceneInputEnabled(idle, true, false, true)).toBe(false);
    expect(sceneInputEnabled(undefined, true, false, false)).toBe(false);
  });
});
