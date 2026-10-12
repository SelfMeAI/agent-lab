import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RemotePendingInputs } from "./RemotePendingInputs";
const queue = { mode: "queue" as const, revision: 1, paused: false, items: [{ id: "input", text: "下一步", at: "2026-10-13T00:00:00Z", state: "queued" as const, files: [] }] };
describe("remote pending messages", () => {
  it("keeps the familiar Steer/delete pair without editing, reordering or pause controls", () => {
    const html = renderToStaticMarkup(createElement(RemotePendingInputs, { queue, running: true, disabled: false, onRemove() {}, onSteer() {} }));
    expect(html).toContain("当前轮结束后合并发送"); expect(html).toContain("Steer"); expect(html).toContain("删除待发消息");
    expect(html).not.toMatch(/编辑|排序|暂停/); expect(html).not.toContain('disabled=""');
  });
  it("truthfully displays retained inputs after Stop and only disables Steer without a run", () => {
    const html = renderToStaticMarkup(createElement(RemotePendingInputs, { queue: { ...queue, paused: true }, running: false, disabled: false, onRemove() {}, onSteer() {} }));
    expect(html).toContain("点击继续后发送"); expect(html.match(/disabled=""/g)).toHaveLength(1);
  });
  it("locks a native admission in flight and hides an empty queue", () => {
    const html = renderToStaticMarkup(createElement(RemotePendingInputs, { queue: { ...queue, items: [{ ...queue.items[0], state: "sending" }] }, running: true, disabled: false, onRemove() {}, onSteer() {} }));
    expect(html).toContain("正在提交"); expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(RemotePendingInputs({ queue: { ...queue, items: [] }, running: false, disabled: false, onRemove() {}, onSteer() {} })).toBeNull();
  });
});
