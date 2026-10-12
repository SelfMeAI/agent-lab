import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RemoteTaskController, remotePreviewKind } from "./task-controller";

const id = "c0ec83da-66be-4f17-a2c2-01dc02c89f00";
let root: string;
let controller: RemoteTaskController;
let choose: Mock<() => Promise<string[]>>;
let save: Mock<(name: string) => Promise<string | null>>;
beforeEach(async () => {
  const directory = resolve(".work/remote-agent/controller-tests"); await mkdir(directory, { recursive: true }); root = await mkdtemp(join(directory, "fixture-"));
  choose = vi.fn(async () => [] as string[]); save = vi.fn(async () => null as string | null);
  const connection = { endpoint: async () => "http://127.0.0.1:1234", credentials: async () => ({ sessionApiKey: "private-service-token", persistenceKey: "private-persistence-key" }) };
  controller = new RemoteTaskController({ openhands: connection, openclaw: connection }, { choose, save }, () => {}, () => {});
});
afterEach(async () => { controller.shutdown(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("remote task files, native dialogs and scoped previews", () => {
  it("returns the native desktop grant without issuing a task instruction", async () => {
    const key = "agent:main:selfme:" + id;
    const native = { url: "ws://127.0.0.1/observe", control: true, expiresAt: Date.now() + 60_000 };
    const desktop = vi.spyOn(controller.claw, "desktop").mockResolvedValue(native);
    const send = vi.spyOn(controller.claw, "send");
    expect(await controller.desktop("openclaw", key)).toEqual(native);
    expect(desktop).toHaveBeenCalledWith(key); expect(send).not.toHaveBeenCalled();
  });
  it("validates the entire upload selection before sending a single file", async () => {
    const small = join(root, "small.txt"), large = join(root, "large.bin");
    await writeFile(small, "small"); await writeFile(large, ""); await truncate(large, 20 * 1024 * 1024 + 1);
    choose.mockResolvedValue([small, large]); const upload = vi.spyOn(controller.hands.http, "upload");
    await expect(controller.upload("openhands", id)).rejects.toThrow("20 MB"); expect(upload).not.toHaveBeenCalled();
  });
  it("enforces the remaining attachment slots across successive selections", async () => {
    choose.mockResolvedValue(["first", "second"]);
    await expect(controller.upload("openhands", id, 1)).rejects.toThrow("还可以附加 1");
    await expect(controller.upload("openhands", id, 0)).rejects.toThrow("10");
    await expect(controller.upload("openhands", id, 11)).rejects.toThrow("10");
  });
  it("sends only uploaded files belonging to this exact engine and task", async () => {
    const file = join(root, "资料.txt"); await writeFile(file, "proof"); choose.mockResolvedValue([file]);
    vi.spyOn(controller.hands.http, "upload").mockImplementation(async (_, path, bytes) => ({ path, name: "remote.txt", size: bytes.length, directory: false, absolutePath: "/workspace/task/" + path }));
    const [uploaded] = await controller.upload("openhands", id), send = vi.spyOn(controller.hands, "send").mockResolvedValue();
    expect(uploaded.name).toBe("资料.txt"); expect(uploaded.path).toMatch(/^uploads\/[0-9a-f]{8}-资料\.txt$/);
    await controller.send("openhands", id, "读取文件", [uploaded]); expect(send).toHaveBeenCalledWith(id, "读取文件", [uploaded]);
    await expect(controller.send("openhands", id, "", [{ ...uploaded, absolutePath: "/other-user/private" }])).rejects.toThrow("不属于");
    await expect(controller.send("openhands", id.replace("c0ec", "a0ec"), "", [uploaded])).rejects.toThrow("不属于");
    await expect(controller.send("openclaw", "agent:main:selfme:" + id, "", [uploaded])).rejects.toThrow("不属于");
  });
  it("does not fetch a remote download when the native Save dialog is cancelled", async () => {
    const download = vi.spyOn(controller.hands.http, "download");
    expect(await controller.download("openhands", id, "proof.txt")).toBe(false); expect(download).not.toHaveBeenCalled();
  });
  it("atomically replaces only the explicitly selected download destination", async () => {
    const destination = join(root, "proof.txt"); await writeFile(destination, "before"); save.mockResolvedValue(destination);
    vi.spyOn(controller.hands.http, "download").mockResolvedValue(new Response("after"));
    expect(await controller.download("openhands", id, "proof.txt")).toBe(true); expect(await readFile(destination, "utf8")).toBe("after");
    expect(await readdir(root)).toEqual(["proof.txt"]);
  });
  it("keeps the original destination intact if a download stream fails", async () => {
    const destination = join(root, "proof.txt"); await writeFile(destination, "keep-me"); save.mockResolvedValue(destination);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("transfer failed")); } });
    vi.spyOn(controller.hands.http, "download").mockResolvedValue(new Response(stream));
    await expect(controller.download("openhands", id, "proof.txt")).rejects.toThrow("transfer failed"); expect(await readFile(destination, "utf8")).toBe("keep-me");
    expect(await readdir(root)).toEqual(["proof.txt"]);
  });
  it("bounds text previews and keeps unsupported binaries download-only", async () => {
    const bytes = new Uint8Array(1024 * 1024 + 20).fill(65);
    vi.spyOn(controller.hands.http, "download").mockImplementation(async (_, path) => path.endsWith(".txt") ? new Response(bytes, { headers: { "content-length": String(bytes.length) } }) : new Response("binary"));
    const text = await controller.preview("openhands", id, "large.txt");
    expect(text.kind).toBe("text"); expect(text.text?.length).toBe(1024 * 1024); expect(text.truncated).toBe(true);
    const binary = await controller.preview("openhands", id, "archive.zip"); expect(binary.kind).toBe("binary"); expect(binary.url).toBeUndefined();
    expect(remotePreviewKind("picture.SVG")).toBe("image"); expect(remotePreviewKind("report.PDF")).toBe("pdf");
  });
  it("proxies only the granted task, strips native keys, and revokes a closed preview", async () => {
    const download = vi.spyOn(controller.hands.http, "download").mockImplementation(async () => new Response("<h1>proof</h1>", { headers: { "content-length": "14" } }));
    const preview = await controller.preview("openhands", id, "preview.html");
    expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/preview\.html$/); expect(preview.url).not.toContain("private");
    const response = await fetch(preview.url!); expect(response.status).toBe(200); expect(await response.text()).toContain("proof");
    expect(download).toHaveBeenLastCalledWith(id, "preview.html");
    expect(response.headers.get("content-security-policy")).toContain("frame-src 'none'"); expect(response.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(preview.url!, { method: "POST" })).status).toBe(405);
    await controller.close("openhands", id); expect((await fetch(preview.url!)).status).toBe(410);
  });
  it("serves PDF as nosniff PDF for the native sandboxed renderer, never HTML", async () => {
    vi.spyOn(controller.hands.http, "download").mockImplementation(async () => new Response("%PDF-1.4\n"));
    const preview = await controller.preview("openhands", id, "proof.pdf"), response = await fetch(preview.url!);
    expect(response.headers.get("content-type")).toBe("application/pdf"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; object-src 'self'; base-uri 'none'; form-action 'none'");
    expect(await response.text()).toContain("%PDF");
  });
  it("previews all six office formats through each engine and downloads the untouched original", async () => {
    for (const engine of ["openhands", "openclaw"] as const) {
      const task = engine === "openclaw" ? "agent:main:selfme:" + id : id, http = controller.client(engine).http;
      const previewOffice = vi.spyOn(http, "previewOffice").mockImplementation(async () => new Response("%PDF-1.7\nconverted", { headers: { "content-type": "application/pdf" } }));
      const download = vi.spyOn(http, "download").mockImplementation(async () => new Response("original Office bytes"));
      for (const ext of ["doc", "docx", "xls", "xlsx", "ppt", "pptx"]) {
        const path = "uploads/中文 " + ext + "." + ext, preview = await controller.preview(engine, task, path);
        expect(preview).toMatchObject({ kind: "pdf", mime: "application/pdf", sourceFormat: "." + ext, truncated: false });
        expect(new URL(preview.url!).pathname.endsWith(".pdf")).toBe(true);
        expect(previewOffice).toHaveBeenLastCalledWith(task, path);
        const response = await fetch(preview.url!);
        expect(response.headers.get("content-type")).toBe("application/pdf"); expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-disposition")).toContain(".pdf"); expect(await response.text()).toContain("converted");
        expect(download).not.toHaveBeenCalled();
        const other = new URL(preview.url!); other.pathname = other.pathname.replace(/[^/]+$/, "other.txt");
        expect((await fetch(other)).status).toBe(403);
      }
      save.mockResolvedValue(join(root, engine + ".docx")); await controller.download(engine, task, "uploads/原文件.docx");
      expect(await readFile(join(root, engine + ".docx"), "utf8")).toBe("original Office bytes");
    }
  });
  it("never revives a closed task's office preview after a slow conversion", async () => {
    let finish: (response: Response) => void = () => {};
    const convert = vi.spyOn(controller.hands.http, "previewOffice").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = controller.preview("openhands", id, "file.docx");
    await vi.waitFor(() => expect(convert).toHaveBeenCalled());
    await controller.close("openhands", id);
    finish(new Response("%PDF-1.7\n", { headers: { "content-type": "application/pdf" } }));
    await expect(pending).rejects.toThrow("预览已关闭");
  });
  it("propagates a failed conversion without issuing a task instruction or fabricating a PDF", async () => {
    vi.spyOn(controller.hands.http, "previewOffice").mockRejectedValue(new Error("此文档无法预览，可以下载原文件"));
    const send = vi.spyOn(controller.hands, "send");
    await expect(controller.preview("openhands", id, "bad.docx")).rejects.toThrow("可以下载原文件"); expect(send).not.toHaveBeenCalled();
  });
  it("rejects traversal and control-file requests before any download or dialog", async () => {
    const download = vi.spyOn(controller.hands.http, "download");
    for (const path of ["../secret", "/absolute", "uploads/.selfme-control", "a\\b"]) {
      await expect(controller.preview("openhands", id, path)).rejects.toThrow("文件路径");
      await expect(controller.download("openhands", id, path)).rejects.toThrow("文件路径");
    }
    expect(download).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
});
