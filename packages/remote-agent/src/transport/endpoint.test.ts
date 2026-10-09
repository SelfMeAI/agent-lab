import { describe, expect, it } from "vitest";
import { remoteEndpoint } from "./endpoint";

describe("remote endpoints", () => {
  it("allows secure remote connections and explicit loopback development", () => {
    expect(remoteEndpoint("https://agent.example.com/")).toBe("https://agent.example.com");
    expect(remoteEndpoint("http://127.0.0.1:8000/", true)).toBe("http://127.0.0.1:8000");
    expect(remoteEndpoint("http://[::1]:8000", true)).toBe("http://[::1]:8000");
  });
  it("does not mistake suffixes or credential URLs for trusted loopback", () => {
    for (const url of ["http://localhost.example.com", "http://192.168.1.2", "file:///tmp/test", "https://key@agent.example.com", "https://agent.example.com/?token=secret", "https://agent.example.com/#secret"]) expect(() => remoteEndpoint(url, true)).toThrow();
    expect(() => remoteEndpoint("http://127.0.0.1:8000")).toThrow();
  });
});
