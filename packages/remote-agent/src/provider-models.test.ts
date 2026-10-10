import { describe, expect, it, vi } from "vitest";
import { discoverConnectedModels, discoverModels } from "./provider-models";

const saved = { protocol: "openai" as const, baseUrl: "https://api.example.com/v1", apiKey: "saved-fixture-key" };
const reply = () => new Response(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }] }));
describe("read-only provider model discovery", () => {
  it("uses only the saved connection key and returns distinct sorted IDs", async () => {
    const request = vi.fn(async () => reply());
    expect(await discoverConnectedModels({ protocol: "openai", baseUrl: saved.baseUrl + "/" }, saved, request)).toEqual(["model-a", "model-b"]);
    expect(request).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.objectContaining({ headers: { Authorization: "Bearer saved-fixture-key" }, redirect: "error" }));
  });
  it("does not forward a saved key to another address or protocol", async () => {
    const request = vi.fn(async () => reply());
    for (const input of [{ protocol: "openai" as const, baseUrl: "https://other.example/v1" }, { protocol: "anthropic" as const, baseUrl: saved.baseUrl }]) {
      await expect(discoverConnectedModels(input, saved, request)).rejects.toThrow("已更改");
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("uses an explicit unsaved key without mutating the saved connection", async () => {
    const request = vi.fn(async () => reply());
    await discoverConnectedModels({ protocol: "anthropic", baseUrl: "https://new.example", apiKey: "new-fixture-key" }, saved, request);
    expect(request).toHaveBeenCalledWith("https://new.example/v1/models", expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "new-fixture-key" }) }));
    expect(saved.apiKey).toBe("saved-fixture-key");
  });
  it("rejects invalid shapes/keys before networking", async () => {
    const request = vi.fn(async () => reply());
    await expect(discoverConnectedModels({ protocol: "openai", baseUrl: saved.baseUrl, apiKey: "a\nb" }, saved, request)).rejects.toThrow("有效的 API Key");
    await expect(discoverConnectedModels({ protocol: "openai", baseUrl: "https://user:secret@example.com" }, saved, request)).rejects.toThrow("API 地址");
    expect(request).not.toHaveBeenCalled();
  });
  it("never exposes provider error bodies and bounds/cancels oversized bodies", async () => {
    await expect(discoverModels(saved.baseUrl, saved.apiKey, "openai", async () => new Response("saved-fixture-key", { status: 401 }))).rejects.toThrow("HTTP 401");
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel }));
    await expect(discoverModels(saved.baseUrl, saved.apiKey, "openai", async () => response)).rejects.toThrow("模型列表过大");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
