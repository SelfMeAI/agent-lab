import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverModels, modelListUrl } from "./model-discovery";

afterEach(() => vi.unstubAllGlobals());

describe("model discovery", () => {
  it("uses Anthropic's versioned endpoint and authentication for Claude", async () => {
    expect(modelListUrl("https://claude.example", "anthropic")).toBe("https://claude.example/v1/models");
    expect(modelListUrl("https://claude.example/v1/", "anthropic")).toBe("https://claude.example/v1/models");
    const request = vi.fn(async () => Response.json({ data: [{ id: "claude-sonnet-4-6" }] })); vi.stubGlobal("fetch", request);
    expect(await discoverModels("https://claude.example", "test-key", "anthropic")).toEqual(["claude-sonnet-4-6"]);
    expect(request).toHaveBeenCalledWith("https://claude.example/v1/models", expect.objectContaining({ headers: { Authorization: "Bearer test-key", "x-api-key": "test-key", "anthropic-version": "2023-06-01" } }));
  });
  it("appends /models to the entered API root and returns distinct model IDs", async () => {
    const request = vi.fn(async () => Response.json({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-a" }] }));
    vi.stubGlobal("fetch", request);
    expect(await discoverModels("https://gateway.example/v1/", "test-key")).toEqual(["model-a", "model-b"]);
    expect(request).toHaveBeenCalledWith("https://gateway.example/v1/models", expect.objectContaining({
      headers: { Authorization: "Bearer test-key" },
      redirect: "error",
    }));
  });

  it("works with an API root that has no /v1 segment", () => {
    expect(modelListUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/models");
  });

  it("rejects unsafe URLs and malformed lists without echoing the credential", async () => {
    expect(() => modelListUrl("https://user:password@gateway.example/v1")).toThrow();
    expect(() => modelListUrl("https://gateway.example/v1/chat/completions")).toThrow("API 根地址");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ models: ["model-a"] })));
    await expect(discoverModels("https://gateway.example/v1", "private-test-key")).rejects.toThrow("接口未返回标准模型列表");
  });

  it("shows the HTTP status when a provider does not offer model discovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(discoverModels("https://gateway.example/v1", "test-key")).rejects.toThrow("HTTP 404");
  });
});
