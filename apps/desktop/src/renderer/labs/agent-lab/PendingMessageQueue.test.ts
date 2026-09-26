import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentSessionQueue } from "../../../../../../packages/contracts/src/index";
import { PendingMessageQueue } from "./PendingMessageQueue";

const queue: AgentSessionQueue = { paused: false, messages: [
  { id: "message", text: "下一项任务", mode: "queue", state: "queued", createdAt: "2026-09-26T10:00:00Z" },
] };
const props = { sessionId: "session", queue, canSteer: true, canResume: true, stopping: false, running: true, configured: true };

describe("queue controls and scope labels", () => {
  it("distinguishes pausing future inputs from stopping current work", () => {
    const html = renderToStaticMarkup(createElement(PendingMessageQueue, props));
    expect(html).toContain("暂停队列");
    expect(html).toContain("只暂停队列自动发送，当前轮继续工作");
    expect(html).toContain("只将这条消息补充到当前轮");
    expect(html).not.toContain("继续队列");
  });

  it("keeps Steer available with a paused queue, but explains when resume will run", () => {
    const html = renderToStaticMarkup(createElement(PendingMessageQueue, { ...props, queue: { ...queue, paused: true } }));
    expect(html).toContain("当前轮继续工作，队列暂不发送");
    expect(html).toContain("恢复自动发送，当前轮结束后继续");
    expect(html).toMatch(/<button class="agent-queue__steer"[^>]*title="只将这条消息补充到当前轮"/);
    expect(html).not.toMatch(/<button class="agent-queue__steer"[^>]*disabled/);
  });

  it("disables resume and Steer while stopping, without hiding unsent content or its menu", () => {
    const html = renderToStaticMarkup(createElement(PendingMessageQueue, {
      ...props, queue: { ...queue, paused: true }, stopping: true, canSteer: false, canResume: false,
    }));
    expect(html).toContain("下一项任务");
    expect(html).toContain("停止完成后可继续队列");
    expect(html).toMatch(/<button class="agent-queue__control"[^>]*disabled/);
    expect(html).toMatch(/<button class="agent-queue__steer"[^>]*disabled/);
    expect(html).not.toMatch(/<button class="agent-queue__more"[^>]*disabled/);
  });

  it("hides empty queues and gives idle resume a different hint from active work", () => {
    expect(renderToStaticMarkup(createElement(PendingMessageQueue, { ...props, queue: { messages: [], paused: true } }))).toBe("");
    const html = renderToStaticMarkup(createElement(PendingMessageQueue, { ...props, queue: { ...queue, paused: true }, running: false, canSteer: false }));
    expect(html).toContain("开始依次发送队列中的消息");
    expect(html).toMatch(/<button class="agent-queue__steer"[^>]*disabled/);
  });
});
