import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RemoteExecutionControl, RemoteExecutionStatus } from "./RemoteExecutionControls";
import type { RemoteTaskStatus } from "../../../../../../packages/contracts/src/remote-agent";

describe("remote execution controls", () => {
  it.each(["running", "waiting"] as const)("keeps stop separate from message submission while %s", status => {
    const onControl = vi.fn();
    const control = RemoteExecutionControl({ status, disabled: false, onControl })!;
    const html = renderToStaticMarkup(control);
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="停止执行"');
    expect(html).toContain('title="停止当前执行；独立运行的服务可能继续运行"');
    expect(html.replace(/<[^>]+>/gu, "")).toBe("");
    expect(html).not.toContain("停止任务");
    expect(html).not.toContain("disabled");
    control.props.onClick();
    expect(onControl).toHaveBeenCalledExactlyOnceWith("stop");
  });
  it("resumes a stopped task using the existing control action", () => {
    const onControl = vi.fn();
    const control = RemoteExecutionControl({ status: "paused", disabled: false, onControl })!;
    const html = renderToStaticMarkup(control);
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="继续任务"');
    expect(html).toContain('title="继续当前任务"');
    expect(html.replace(/<[^>]+>/gu, "")).toBe("");
    expect(html).not.toContain("停止执行");
    control.props.onClick();
    expect(onControl).toHaveBeenCalledExactlyOnceWith("resume");
  });
  it.each(["running", "waiting", "paused"] as const)("retains the action-in-flight guard for %s", status => {
    expect(renderToStaticMarkup(createElement(RemoteExecutionControl, { status, disabled: true, onControl() {} }))).toContain('disabled=""');
  });
  it.each([undefined, "idle", "completed", "error"] as const)("does not invent a control for %s", status => {
    expect(RemoteExecutionControl({ status, disabled: false, onControl() {} })).toBeNull();
  });
  it.each([
    ["running", "工作中", true], ["waiting", "待确认", false], ["paused", "已停止", false],
    ["completed", "已完成", false], ["idle", "待命", false], ["error", "本轮中断", false],
  ] satisfies [RemoteTaskStatus, string, boolean][])("shows an accurate, accessible %s status", (status, label, spinning) => {
    const html = renderToStaticMarkup(createElement(RemoteExecutionStatus, { status, opening: false }));
    expect(html).toContain('class="remote-composer__status"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(label);
    expect(html.includes("remote-spinner")).toBe(spinning);
    if (status === "error") expect(html).toContain("可以继续发送消息");
  });
  it("shows task loading rather than a stale status during selection", () => {
    const html = renderToStaticMarkup(createElement(RemoteExecutionStatus, { status: "running", opening: true }));
    expect(html).toContain("正在读取任务");
    expect(html).toContain("remote-spinner");
    expect(html).not.toContain("工作中");
  });
  it("does not show a fictitious status when no task is selected", () => {
    expect(RemoteExecutionStatus({ opening: false })).toBeNull();
  });
});
