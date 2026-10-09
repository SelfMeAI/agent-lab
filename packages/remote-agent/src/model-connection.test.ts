import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteModelClient, validateRemoteModel } from "./model-connection";

afterEach(() => vi.unstubAllGlobals());
describe("remote native model connection", () => {
  it("normalizes protocol/model input without embedding keys in URLs", () => {
    expect(validateRemoteModel({ protocol: "openai", baseUrl: "https://api.deepseek.com/", model: " deepseek-chat " })).toEqual({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: undefined });
    for (const baseUrl of ["file:///host", "https://user:secret@example.com", "https://example.com?key=secret", "https://example.com#key"]) {
      expect(() => validateRemoteModel({ protocol: "openai", baseUrl, model: "model" })).toThrow();
    }
    expect(() => validateRemoteModel({ protocol: "openai", baseUrl: "https://example.com", model: "" })).toThrow();
    expect(() => validateRemoteModel({ protocol: "openai", baseUrl: "https://example.com", model: "model", apiKey: "a\nb" })).toThrow();
  });
  it("preserves an existing native key on an omitted/empty API Key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agent_settings: { llm: { model: "openai/deepseek-chat", base_url: "https://api.deepseek.com", api_key: "**********" } }, llm_api_key_is_set: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const client = new RemoteModelClient("openhands", async () => "http://127.0.0.1:1234", async () => ({ sessionApiKey: "fixture" }));
    const result = await client.save({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "" });
    const call = fetchMock.mock.calls.find(args => args[1]?.method === "PATCH");
    expect(JSON.parse(call![1].body).agent_settings_diff.llm).not.toHaveProperty("api_key");
    expect(result).toEqual({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", configured: true });
    expect(JSON.stringify(result)).not.toContain("**********");
  });
  it("does not save an unconfigured connection without a key, nor disclose native errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ llm_api_key_is_set: false }) }));
    const client = new RemoteModelClient("openhands", async () => "http://127.0.0.1:1234", async () => ({ sessionApiKey: "fixture" }));
    await expect(client.save({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" })).rejects.toThrow("API Key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => "private-key" }));
    await expect(client.get()).rejects.toThrow("422");
    await expect(client.get()).rejects.not.toThrow("private-key");
  });
});
