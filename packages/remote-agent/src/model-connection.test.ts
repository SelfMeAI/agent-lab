import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteModelClient, validateRemoteModel } from "./model-connection";
import { knownRemoteVision } from "./model-capabilities";

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
  it("distinguishes official vision Flash from text Pro and unknown proxy aliases", () => {
    expect(knownRemoteVision("https://api.deepseek.com", "deepseek-flash")).toBe(true);
    expect(knownRemoteVision("https://api.deepseek.com", "deepseek-v4-pro")).toBe(false);
    expect(knownRemoteVision("https://example.com", "deepseek-flash")).toBeUndefined();
    expect(knownRemoteVision("https://api.deepseek.com", "unknown")).toBeUndefined();
  });
  it("persists explicit vision support in the native SDK instead of assuming text only", async () => {
    const native = { agent_settings: { llm: { model: "openai/vision-model", base_url: "https://example.com", capability_overrides: { supports_vision: true } } }, llm_api_key_is_set: true };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => native }); vi.stubGlobal("fetch", fetchMock);
    const client = new RemoteModelClient("openhands", async () => "http://127.0.0.1:1234", async () => ({ sessionApiKey: "fixture" }));
    expect(await client.save({ protocol: "openai", baseUrl: "https://example.com", model: "vision-model", supportsImages: true })).toMatchObject({ supportsImages: true });
    const call = fetchMock.mock.calls.find(args => args[1]?.method === "PATCH");
    expect(JSON.parse(call![1].body).agent_settings_diff.llm.capability_overrides).toEqual({ supports_vision: true });
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
  it("delegates lookup to the authenticated server without saving or receiving secrets", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: ["model-b", "model-a", "model-a", "bad model"] }) });
    vi.stubGlobal("fetch", fetchMock);
    const client = new RemoteModelClient("openhands", async () => "http://127.0.0.1:1234", async () => ({ sessionApiKey: "fixture-session" }));
    expect(await client.listModels({ protocol: "openai", baseUrl: "https://api.deepseek.com" })).toEqual(["model-a", "model-b"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1234/api/selfme/models"); expect(options.method).toBe("POST");
    expect(options.headers["X-Session-API-Key"]).toBe("fixture-session");
    expect(JSON.parse(options.body)).toEqual({ protocol: "openai", baseUrl: "https://api.deepseek.com" });
  });
  it("reports sanitized lookup errors while allowing manual model entry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ detail: "连接地址或协议已更改，请填写对应的 API Key" }) }));
    const client = new RemoteModelClient("openhands", async () => "http://127.0.0.1:1234", async () => ({ sessionApiKey: "fixture" }));
    await expect(client.listModels({ protocol: "anthropic", baseUrl: "https://other.example" })).rejects.toThrow("已更改");
  });
});
