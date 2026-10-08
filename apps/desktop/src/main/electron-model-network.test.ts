import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const electron = vi.hoisted(() => ({ request: vi.fn(), session: {} }));
vi.mock("electron", () => ({ net: { request: electron.request }, session: { defaultSession: electron.session } }));
import { electronModelMetadataFetch } from "./electron-model-network";

const options = { redirect: "manual", credentials: "omit" } as const;
const url = "https://huggingface.co/v2/owner/model/blobs/sha256:test";
class Request extends EventEmitter {
  // Electron's outgoing Writable finishes/closes independently of the response.
  end = vi.fn(() => { this.emit("finish"); this.emit("close"); return this; });
  followRedirect = vi.fn();
  abort = vi.fn(() => { this.emit("abort"); this.emit("error", new Error("Redirect was cancelled")); this.emit("close"); });
}
class Incoming extends EventEmitter {
  constructor(readonly statusCode = 200, readonly headers: Record<string, string | string[]> = { "content-type": "text/plain", "set-cookie": ["a=1", "b=2"] }) { super(); }
}
let request: Request;
beforeEach(() => { electron.request.mockReset(); request = new Request(); electron.request.mockReturnValue(request); });

describe("Electron metadata networking", () => {
  it("exposes a manual redirect without following or surfacing Electron's cancellation", async () => {
    const result = electronModelMetadataFetch(url, options);
    request.emit("redirect", 302, "GET", "https://huggingface.co/resolve/license", {});
    const response = await result;
    expect(response.status).toBe(302); expect(response.headers.get("location")).toBe("https://huggingface.co/resolve/license");
    expect(request.abort).toHaveBeenCalledOnce(); expect(request.followRedirect).not.toHaveBeenCalled();
    expect(electron.request).toHaveBeenCalledExactlyOnceWith({ url, method: "GET", session: electron.session, redirect: "manual", credentials: "omit", useSessionCookies: false });
  });
  it("collects bounded response bytes and preserves status and headers", async () => {
    const result = electronModelMetadataFetch(url, options), incoming = new Incoming();
    request.emit("response", incoming); incoming.emit("data", Buffer.from("license ")); incoming.emit("data", Buffer.from("content")); incoming.emit("end"); request.emit("close");
    const response = await result; expect(await response.text()).toBe("license content"); expect(response.headers.get("content-type")).toBe("text/plain"); expect(request.abort).not.toHaveBeenCalled();
    const failed = electronModelMetadataFetch(url, options), notFound = new Incoming(404);
    request.emit("response", notFound); notFound.emit("data", Buffer.from("not found")); notFound.emit("end");
    expect((await failed).status).toBe(404);
  });
  it("cancels the real request on abort or timeout and rejects an already aborted signal before networking", async () => {
    const controller = new AbortController(), result = electronModelMetadataFetch(url, { ...options, signal: controller.signal });
    controller.abort(new Error("pause")); await expect(result).rejects.toThrow("pause"); expect(request.abort).toHaveBeenCalledOnce();
    electron.request.mockClear(); await expect(electronModelMetadataFetch(url, { ...options, signal: controller.signal })).rejects.toThrow("pause"); expect(electron.request).not.toHaveBeenCalled();
    const timed = electronModelMetadataFetch(url, { ...options, signal: AbortSignal.timeout(10) });
    await expect(timed).rejects.toThrow(/timeout|timed out/iu);
  });
  it("rejects oversized and interrupted responses without hanging", async () => {
    const large = electronModelMetadataFetch(url, options), incoming = new Incoming();
    request.emit("response", incoming); incoming.emit("data", Buffer.alloc(1024 * 1024 + 1));
    await expect(large).rejects.toThrow("超过允许大小"); expect(request.abort).toHaveBeenCalledOnce();
    const interrupted = electronModelMetadataFetch(url, options), partial = new Incoming();
    request.emit("response", partial); partial.emit("data", Buffer.from("partial")); partial.emit("aborted");
    await expect(interrupted).rejects.toThrow("下载中断");
    const closed = electronModelMetadataFetch(url, options), response = new Incoming();
    request.emit("response", response); response.emit("close"); await expect(closed).rejects.toThrow("提前结束");
    const error = electronModelMetadataFetch(url, options); request.emit("error", new Error("network unavailable")); await expect(error).rejects.toThrow("network unavailable");
  });
  it("does not reuse a finished request's abort listener or accept unsafe request modes", async () => {
    const controller = new AbortController(), result = electronModelMetadataFetch(url, { ...options, signal: controller.signal }), incoming = new Incoming(204, {});
    request.emit("response", incoming); incoming.emit("end"); expect((await result).status).toBe(204);
    controller.abort(); expect(request.abort).not.toHaveBeenCalled();
    for (const invalid of [{ redirect: "follow" }, { credentials: "include" }, { method: "POST" }, { body: "secret" }]) {
      await expect(electronModelMetadataFetch(url, { ...options, ...invalid } as RequestInit)).rejects.toThrow("无凭据");
    }
    expect(electron.request).toHaveBeenCalledOnce();
  });
});
