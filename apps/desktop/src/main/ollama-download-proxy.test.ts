import { describe, expect, it } from "vitest";
import { ollamaDownloadProxy } from "./ollama-download-proxy";

describe("embedded runtime download proxy", () => {
  it("inherits the user's system proxy, keeps local inference off the proxy and does not mutate environment", () => {
    const env = { NO_PROXY: "internal.example" };
    expect(ollamaDownloadProxy(env, "PROXY 127.0.0.1:7897; DIRECT")).toEqual({ HTTP_PROXY: "http://127.0.0.1:7897", HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: "internal.example,localhost,127.0.0.1,::1" });
    expect(env).toEqual({ NO_PROXY: "internal.example" }); expect(ollamaDownloadProxy({}, "DIRECT")).toEqual({});
    expect(ollamaDownloadProxy({}, "DIRECT; PROXY example.com:3128")).toEqual({});
  });
  it("honors explicitly configured environment proxies without disclosing or replacing them", () => {
    expect(ollamaDownloadProxy({ HTTPS_PROXY: "http://existing:8080" }, "PROXY 127.0.0.1:7897").HTTPS_PROXY).toBe("http://existing:8080");
    expect(ollamaDownloadProxy({}, "SOCKS5 127.0.0.1:1080").HTTPS_PROXY).toBe("socks5://127.0.0.1:1080");
  });
});
