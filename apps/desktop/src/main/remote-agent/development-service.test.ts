import { describe, expect, it, vi } from "vitest";
import type { RemoteModelConnection, RemoteServiceState } from "../../../../../packages/contracts/src/remote-agent";
import { RemoteDevelopmentService } from "./development-service";

const state: RemoteServiceState = { phase: "ready", running: true, dockerAvailable: true, imageReady: true, endpoint: "http://127.0.0.1:1234", version: "fixture", detail: "ready" };
const connection: RemoteModelConnection = { protocol: "openai", model: "fixture-model", baseUrl: "https://api.deepseek.com", configured: true };
function fixture(configured = false) {
  const container = { state: vi.fn(async () => state), control: vi.fn(async () => state), logs: vi.fn(async () => "logs") };
  const model = { get: vi.fn(async () => ({ ...connection, configured })), save: vi.fn(async () => connection) };
  const initial = vi.fn(async () => ({ protocol: "openai" as const, baseUrl: connection.baseUrl, model: connection.model, apiKey: "fixture-key" }));
  return { container, model, initial, service: new RemoteDevelopmentService(container, model, initial) };
}
describe("development service coordination", () => {
  it("retains a deployment-upgrade warning from the container without interrupting work", async () => {
    const test = fixture(true);
    test.container.state.mockResolvedValue({ ...state, setupWarning: "请空闲时重启此服务" });
    expect(await test.service.state()).toMatchObject({ phase: "ready", setupWarning: "请空闲时重启此服务" });
    expect(test.container.control).not.toHaveBeenCalled();
  });
  it("seeds only an unconfigured native server, never overwrites a saved connection", async () => {
    const empty = fixture(); await empty.service.control("start"); expect(empty.model.save).toHaveBeenCalledOnce();
    const saved = fixture(true); await saved.service.control("restart"); expect(saved.model.save).not.toHaveBeenCalled(); expect(saved.initial).not.toHaveBeenCalled();
    const stopped = fixture(); await stopped.service.control("stop"); expect(stopped.model.get).not.toHaveBeenCalled();
  });
  it("holds lifecycle exclusivity until first native configuration is complete", async () => {
    const test = fixture(); let finish!: (value: RemoteModelConnection) => void;
    test.model.save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const starting = test.service.control("start");
    await vi.waitFor(() => expect(test.model.save).toHaveBeenCalledOnce());
    expect((await test.service.state()).phase).toBe("starting");
    await expect(test.service.control("stop")).rejects.toThrow("处理中");
    expect(() => test.service.getModel()).toThrow("处理中");
    finish(connection); expect((await starting).phase).toBe("ready");
    await expect(test.service.getModel()).resolves.toEqual({ ...connection, configured: false });
  });
  it("keeps a setup warning visible on later refreshes, without pretending start failed", async () => {
    const test = fixture(); test.model.save.mockRejectedValue(new Error("provider key rejected sk-fixture-private-secret"));
    expect((await test.service.control("start")).phase).toBe("ready");
    const refresh = await test.service.state();
    expect(refresh.setupWarning).toContain("模型连接需检查"); expect(refresh.setupWarning).not.toContain("sk-fixture-private");
    test.model.save.mockResolvedValue(connection); await test.service.saveModel({ protocol: "openai", baseUrl: connection.baseUrl, model: connection.model, apiKey: "valid-fixture" });
    expect((await test.service.state()).setupWarning).toBeUndefined();
  });
  it("does not leak user-supplied keys through native configuration errors", async () => {
    const test = fixture(true); test.model.save.mockRejectedValue(new Error("rejected private-fixture-value"));
    await expect(test.service.saveModel({ protocol: "openai", baseUrl: connection.baseUrl, model: connection.model, apiKey: "private-fixture-value" })).rejects.toThrow("rejected [已隐藏]");
    expect((await test.service.state()).phase).toBe("ready");
  });
});
