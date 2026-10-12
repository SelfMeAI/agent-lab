import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { convertOffice, DocumentPreviewError, previewFailure } from "../../../../../services/remote-agent/document-preview/office-preview.mjs";
const url = "http://selfme-lab-document-preview-0123456789abcdef:3000";
let root: string;
beforeEach(async () => { const base = resolve(".work/remote-agent/office-tests"); await mkdir(base, { recursive: true }); root = await mkdtemp(join(base, "fixture-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("shared Office conversion helper", () => {
  it("uploads a copy without a native directory, model key, index refresh or editable form fields", async () => {
    const source = join(root, "私有文档.docx"), bytes = Buffer.from("504b0304", "hex"); await writeFile(source, bytes);
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("%PDF-1.7\nproof", { headers: { "content-type": "application/pdf" } }));
    expect((await convertOffice(source, url, request)).toString()).toContain("%PDF-");
    const [endpoint, options] = request.mock.calls[0]; expect(endpoint).toBe(url + "/forms/libreoffice/convert");
    expect(options!.headers).toBeUndefined(); expect(options!.redirect).toBe("error");
    const form = options!.body as FormData, file = form.get("files") as File;
    expect(file.name).toBe("document.docx"); expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    expect(form.get("updateIndexes")).toBe("false"); expect(form.get("exportFormFields")).toBe("false");
    expect(await readFile(source)).toEqual(bytes);
  });
  it("rejects unsupported formats, public renderer URLs and symlinks before sending content", async () => {
    const source = join(root, "file.docx"); await writeFile(source, Buffer.from("504b0304", "hex"));
    const request = vi.fn<typeof fetch>();
    await expect(convertOffice(source, "https://example.com", request)).rejects.toThrow("未就绪");
    await expect(convertOffice(join(root, "file.exe"), url, request)).rejects.toThrow("不支持");
    const link = join(root, "link.docx"); await symlink(source, link);
    await expect(convertOffice(link, url, request)).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  });
  it("rejects renamed or corrupt files and safely reports password-protected documents", async () => {
    const source = join(root, "bad.docx"); await writeFile(source, "not an Office document");
    const request = vi.fn<typeof fetch>(); await expect(convertOffice(source, url, request)).rejects.toThrow("格式不匹配"); expect(request).not.toHaveBeenCalled();
    await writeFile(source, Buffer.from("d0cf11e0a1b11ae1", "hex"));
    request.mockResolvedValue(new Response("provider-key and private converter output", { status: 400 }));
    const error = await convertOffice(source, url, request).catch(error => error);
    expect(error).toBeInstanceOf(DocumentPreviewError); expect(error.message).toBe(previewFailure(400)); expect(error.message).not.toContain("provider-key");
  });
  it("maps timeouts to retryable document errors and rejects an HTML response pretending to be PDF", async () => {
    const source = join(root, "file.pptx"); await writeFile(source, Buffer.from("504b0304", "hex"));
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("private request data"));
    await expect(convertOffice(source, url, request)).rejects.toMatchObject({ status: 503, message: previewFailure(503) });
    request.mockResolvedValue(new Response("<html>not PDF</html>", { headers: { "content-type": "application/pdf" } }));
    await expect(convertOffice(source, url, request)).rejects.toMatchObject({ status: 502 });
  });
});
