import { describe, expect, it } from "vitest";
import type { RemoteServiceState } from "../../../../../../packages/contracts/src/remote-agent";
import { remoteError, remoteServiceLabel } from "./service-presentation";

const state: RemoteServiceState = { phase: "ready", running: true, dockerAvailable: true, imageReady: true, version: "fixture", endpoint: "http://127.0.0.1:1234", detail: "connected" };
describe("truthful remote service presentation", () => {
  it("distinguishes live/authenticated, not-started, unavailable and authentication failure", () => {
    expect(remoteServiceLabel()).toBe("读取服务状态…");
    expect(remoteServiceLabel(state)).toBe("服务运行中");
    expect(remoteServiceLabel({ ...state, phase: "error" })).toBe("运行中 · 连接异常");
    expect(remoteServiceLabel({ ...state, phase: "stopped", running: false })).toBe("服务未启动");
    expect(remoteServiceLabel({ ...state, phase: "error", dockerAvailable: false })).toBe("Docker 未就绪");
    expect(remoteServiceLabel({ ...state, phase: "starting" })).toBe("正在启动…");
  });
  it("removes IPC wrapper wording, not the actual useful error", () => {
    expect(remoteError(new Error("Error invoking remote method 'agent-lab:remote-model-get': Error: 服务认证失败"))).toBe("服务认证失败");
  });
});
