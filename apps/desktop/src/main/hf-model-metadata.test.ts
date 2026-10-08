import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { prepareHuggingFaceMetadata, type ModelMetadataFetch } from "./hf-model-metadata";
import { DownloadProgress } from "./local-model-download";
import type { OllamaChunk } from "../../../../packages/runtime/src/ollama";

const model = "hf.co/LiquidAI/Test-GGUF:Q4_0";
const base = "https://huggingface.co/v2/LiquidAI/Test-GGUF";
const layer = (text: string, kind: string): { digest: string; size: number; mediaType: string } => ({
  digest: `sha256:${createHash("sha256").update(text).digest("hex")}`, size: Buffer.byteLength(text),
  mediaType: kind === "config" ? "application/vnd.docker.container.image.v1+json" : `application/vnd.ollama.image.${kind}`,
});
function fixture() {
  const files = ["license file", "chat template", "{\"temperature\":0.7}", "{\"format\":\"gguf\"}"];
  const metadata = files.map((text, index) => layer(text, ["license", "template", "params", "config"][index]));
  const weights = { ...layer("weights", "model"), size: 219309792 };
  const manifest = { schemaVersion: 2, layers: [weights, ...metadata.slice(0, 3)], config: metadata[3] };
  const cached = new Set([weights.digest]);
  const client = { hasBlob: vi.fn(async (digest: string) => cached.has(digest)), cacheBlob: vi.fn(async (digest: string, _bytes: Uint8Array, _signal: AbortSignal) => { cached.add(digest); }) };
  const request = vi.fn<ModelMetadataFetch>(async (url, options) => {
    expect(options?.redirect).toBe("manual"); expect(options?.credentials).toBe("omit"); expect(options?.signal).toBeInstanceOf(AbortSignal);
    if (url === `${base}/manifests/Q4_0`) return Response.json(manifest);
    const index = metadata.findIndex((item) => url === `${base}/blobs/${item.digest}`);
    if (index < 0) throw new Error(`unexpected download: ${url}`);
    return new Response(files[index]);
  });
  const chunks: OllamaChunk[] = [], planned: { digest: string; total: number }[][] = [];
  const options = { signal: new AbortController().signal, request, receive: (chunk: OllamaChunk) => { chunks.push(chunk); }, plan: (items: { digest: string; total: number }[]) => { planned.push(items); } };
  return { client, request, options, metadata, weights, manifest, files, chunks, planned, cached };
}

describe("public HF model companion downloads", () => {
  it("leaves native Ollama registry transfers untouched", async () => {
    const { client, options, request } = fixture();
    await prepareHuggingFaceMetadata("qwen3:0.6b", client, options);
    expect(request).not.toHaveBeenCalled(); expect(client.hasBlob).not.toHaveBeenCalled();
  });
  it("uses the existing network session for SHA-verified metadata, reuses weights and plans every layer before reporting bytes", async () => {
    const f = fixture();
    await prepareHuggingFaceMetadata(model, f.client, f.options);
    expect(f.planned[0]).toHaveLength(5);
    expect(f.planned[0].reduce((sum, item) => sum + item.total, 0)).toBe(f.weights.size + f.metadata.reduce((sum, item) => sum + item.size, 0));
    expect(f.request).toHaveBeenCalledTimes(5); expect(f.client.cacheBlob).toHaveBeenCalledTimes(4);
    expect(f.chunks[0]).toMatchObject({ status: "pulling cached model", completed: f.weights.size, total: f.weights.size });
    expect(f.chunks.some((chunk) => chunk.status === "pulling metadata license" && chunk.completed === 0)).toBe(true);
    const progress = new DownloadProgress(); progress.plan(f.planned[0]);
    expect(progress.receive(f.chunks[0], 0)).toMatchObject({ completed: f.weights.size, bytesPerSecond: null });
    for (const chunk of f.chunks.slice(1)) progress.receive(chunk);
    expect(progress.receive({ status: "pulling manifest" })).toMatchObject({ completed: f.planned[0].reduce((sum, item) => sum + item.total, 0) });
    await prepareHuggingFaceMetadata(model, f.client, f.options);
    expect(f.request).toHaveBeenCalledTimes(6); expect(f.client.cacheBlob).toHaveBeenCalledTimes(4);
  });
  it("follows only public HF HTTPS redirects and does not forward credentials", async () => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => new Response(null, { status: 307, headers: { location: "https://huggingface.co/registry-manifest" } }))
      .mockImplementationOnce(async (url) => { expect(url).toBe("https://huggingface.co/registry-manifest"); return Response.json(f.manifest); });
    await prepareHuggingFaceMetadata(model, f.client, f.options);
    expect(f.client.cacheBlob).toHaveBeenCalledTimes(4);
    f.request.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    await expect(prepareHuggingFaceMetadata(model, f.client, f.options)).rejects.toThrow("不受支持");
    expect(f.request.mock.calls.some(([url]) => url.includes("127.0.0.1"))).toBe(false);
  });
  it("rejects hash mismatches, truncation and oversized bodies before storing a file", async () => {
    for (const invalid of ["wrong content", "x", "x".repeat(30)]) {
      const f = fixture();
      f.request.mockImplementationOnce(async () => Response.json(f.manifest)).mockImplementationOnce(async () => new Response(invalid));
      await expect(prepareHuggingFaceMetadata(model, f.client, f.options)).rejects.toThrow(/校验失败|超过允许大小/u);
      expect(f.client.cacheBlob).not.toHaveBeenCalled();
    }
  });
  it("pause or cancel during a companion request cannot write later or leak into the next attempt", async () => {
    const f = fixture(), controller = new AbortController();
    f.options.signal = controller.signal;
    f.request.mockImplementationOnce(async () => Response.json(f.manifest)).mockImplementationOnce(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }); controller.abort();
    }));
    await expect(prepareHuggingFaceMetadata(model, f.client, f.options)).rejects.toThrow();
    expect(f.client.cacheBlob).not.toHaveBeenCalled();
    f.options.signal = new AbortController().signal;
    await prepareHuggingFaceMetadata(model, f.client, f.options);
    expect(f.client.cacheBlob).toHaveBeenCalledTimes(4);
  });
  it("rejects malformed manifests and invalid paths without importing anything", async () => {
    const f = fixture();
    await expect(prepareHuggingFaceMetadata("hf.co/../bad:Q4", f.client, f.options)).rejects.toThrow("格式"); expect(f.request).not.toHaveBeenCalled();
    f.request.mockImplementationOnce(async () => Response.json({ ...f.manifest, config: { ...f.manifest.config, digest: "../../escape" } }));
    await expect(prepareHuggingFaceMetadata(model, f.client, f.options)).rejects.toThrow("信息无效");
    expect(f.client.cacheBlob).not.toHaveBeenCalled();
    f.request.mockImplementationOnce(async () => Response.json({ ...f.manifest, layers: Array(257).fill(f.weights) }));
    await expect(prepareHuggingFaceMetadata(model, f.client, f.options)).rejects.toThrow("格式无效");
  });
});
