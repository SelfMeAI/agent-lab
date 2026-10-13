import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RemoteModelImageCapability, RemoteServicePanel } from "./RemoteServicePanel";
import type { RemoteServiceState } from "../../../../../../packages/contracts/src/remote-agent";

const state: RemoteServiceState = { phase: "ready", running: true, dockerAvailable: true, imageReady: true, endpoint: "http://127.0.0.1:1234", version: "fixture", detail: "ready" };
describe("remote model connection settings", () => {
  for (const initialEngine of ["openclaw", "openhands"] as const) it(`${initialEngine}: exposes a read-only lookup and retains manual entry`, () => {
    const html = renderToStaticMarkup(createElement(RemoteServicePanel, { initialEngine, states: { openhands: state, openclaw: state }, busy: {}, errors: {}, onControl: async () => {}, onClose() {} }));
    expect(html).toContain("获取模型"); expect(html).toContain('id="remote-model-id"'); expect(html).toContain("输入模型 ID");
    expect(html).toContain("保存连接"); expect(html).toContain("图像能力"); expect(html).toContain("待确认"); expect(html).not.toContain('type="checkbox"'); expect(html).not.toContain("sk-");
    expect(html.match(/关闭应用不会停止服务/g)).toHaveLength(1);
    expect(html).not.toContain("关闭应用不停止远端服务");
  });
  it.each([
    ["https://api.deepseek.com", "deepseek-flash", "支持", "true"],
    ["https://api.deepseek.com", "deepseek-v4-pro", "不支持", "false"],
    ["https://api.deepseek.com", "unknown-model", "待确认", "unknown"],
    ["https://example.com", "deepseek-flash", "待确认", "unknown"],
    ["https://api.deepseek.com", "", "待确认", "unknown"],
  ])("shows a read-only capability for %s / %s", (baseUrl, model, label, support) => {
    const html = renderToStaticMarkup(createElement(RemoteModelImageCapability, { baseUrl, model }));
    expect(html).toContain(`data-support="${support}">${label}</strong>`);
    expect(html).not.toMatch(/<(?:input|button|select)\b/u);
  });
});
