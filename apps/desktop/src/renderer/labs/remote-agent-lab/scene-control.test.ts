import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SceneControlDialog } from "./scene-control";

describe("shared remote scene control", () => {
  const props = { busy: false, followUp: "", onFollowUp() {}, onCancel() {}, onAcquire() {}, onReturn() {} };
  it("describes one takeover for all three views, without a forced Desktop jump", () => {
    const html = renderToStaticMarkup(createElement(SceneControlDialog, { ...props, returning: false }));
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("桌面、浏览器和人工终端一起交给你操作");
    expect(html).toContain("停止并接管");
    expect(html).not.toContain("切换到桌面");
  });
  it("keeps return-with-or-without-resume explicit and restores all views to read-only", () => {
    const html = renderToStaticMarkup(createElement(SceneControlDialog, { ...props, returning: true }));
    expect(html).toContain("交还控制");
    expect(html).toContain("桌面、浏览器和人工终端恢复只读");
    expect(html).toContain("交还，等待指令");
    expect(html).toContain("交还并继续");
  });
});
