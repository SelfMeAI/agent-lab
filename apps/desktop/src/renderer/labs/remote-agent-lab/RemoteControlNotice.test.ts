import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RemoteControlNotice, RemoteLockMark } from "./RemoteControlNotice";

describe("remote desktop control feedback", () => {
  it("explains the temporary restrictions and keeps handback directly accessible", () => {
    const html = renderToStaticMarkup(createElement(RemoteControlNotice, { onHandback() {} }));
    expect(html).toContain('role="status"');
    expect(html).toContain("你正在接管远端现场");
    expect(html).toContain("智能体操作已暂停");
    expect(html).toContain("交还后可切换任务和发送消息");
    expect(html).toContain("交还控制");
    expect(html).toContain('type="button"');
    expect(html).not.toContain("disabled=");
    expect(html).not.toContain('role="alert"');
  });
  it("uses a decorative lock without replacing the readable explanation", () => {
    const html = renderToStaticMarkup(createElement(RemoteLockMark));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('viewBox="0 0 20 20"');
    expect(html).not.toContain('role="button"');
  });
});
