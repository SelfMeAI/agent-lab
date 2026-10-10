import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RemoteServicePanel } from "./RemoteServicePanel";
import type { RemoteServiceState } from "../../../../../../packages/contracts/src/remote-agent";

const state: RemoteServiceState = { phase: "ready", running: true, dockerAvailable: true, imageReady: true, endpoint: "http://127.0.0.1:1234", version: "fixture", detail: "ready" };
describe("remote model connection settings", () => {
  for (const initialEngine of ["openclaw", "openhands"] as const) it(`${initialEngine}: exposes a read-only lookup and retains manual entry`, () => {
    const html = renderToStaticMarkup(createElement(RemoteServicePanel, { initialEngine, states: { openhands: state, openclaw: state }, busy: {}, errors: {}, onControl: async () => {}, onClose() {} }));
    expect(html).toContain("获取模型"); expect(html).toContain('id="remote-model-id"'); expect(html).toContain("输入模型 ID");
    expect(html).toContain("保存连接"); expect(html).toContain("此模型支持读取图片"); expect(html).not.toContain("sk-");
  });
});
