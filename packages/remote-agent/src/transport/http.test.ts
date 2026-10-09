import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteHttp, RemoteHttpError, remoteFilePath, remoteTaskId } from "./http";

const id = "c0ec83da-66be-4f17-a2c2-01dc02c89f00";
afterEach(() => vi.unstubAllGlobals());
describe("remote task-scoped HTTP", () => {
  it("accepts own native ids and rejects malformed ids", () => {
    expect(remoteTaskId(id)).toBe(id); expect(remoteTaskId("agent:main:selfme:" + id)).toBe(id);
    for (const value of ["../../task", id + "/file", "not-a-task", ""]) expect(() => remoteTaskId(value)).toThrow();
  });
  it("rejects traversal, absolute paths, hidden control files and backslashes", () => {
    for (const path of ["../secret", "a/../../x", "/etc/passwd", "a\\b", "a/\0b", ".selfme-workspace", "a/.selfme-upload-x"]) expect(() => remoteFilePath(path)).toThrow();
    expect(remoteFilePath("uploads/普通 文件.txt")).toBe("uploads/普通 文件.txt"); expect(remoteFilePath("")).toBe("");
  });
  it("keeps credentials in request headers and encodes native task/file scope", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ path: "", files: [] }), { headers: { "Content-Type": "application/json" } })); vi.stubGlobal("fetch", fetcher);
    const http = new RemoteHttp("openhands", async () => "http://127.0.0.1:1234", async () => "private-key");
    await http.listFiles(id, "folder/普通 文件");
    const [url, options] = fetcher.mock.calls[0]; expect(url).not.toContain("private-key");
    expect(new URL(url).searchParams.get("task")).toBe(id); expect(new URL(url).searchParams.get("path")).toBe("folder/普通 文件");
    expect(options.headers).toMatchObject({ "X-Session-API-Key": "private-key" });
    expect(options.redirect).toBe("error");
  });
  it("uses native bearer auth for OpenClaw and resets lifecycle endpoints", async () => {
    let endpoint = "http://127.0.0.1:1234";
    const fetcher = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetcher);
    const http = new RemoteHttp("openclaw", async () => endpoint, async () => "key");
    await http.request("/selfme-lab/files"); endpoint = "http://127.0.0.1:5678"; http.reset(); await http.request("/selfme-lab/files");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer key"); expect(fetcher.mock.calls[1][0]).toContain(":5678/");
  });
  it("does not echo an HTML gateway error or accidental credential blob", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>private-key</html>", { status: 502 })));
    const http = new RemoteHttp("openclaw", async () => "http://127.0.0.1:1234", async () => "private-key");
    const error = await http.request("/error").catch(error => error);
    expect(error).toBeInstanceOf(RemoteHttpError); expect(error.status).toBe(502); expect(error.message).not.toContain("private-key");
  });
  it("rejects insecure non-loopback endpoints before a request", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const http = new RemoteHttp("openclaw", async () => "http://example.com", async () => "key");
    await expect(http.request("/files")).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
});
