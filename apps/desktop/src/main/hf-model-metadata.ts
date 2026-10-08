import { createHash } from "node:crypto";
import { OllamaClient, validLocalModelName, type OllamaChunk } from "../../../../packages/runtime/src/ollama";

export type ModelMetadataFetch = (url: string, options?: RequestInit) => Promise<Response>;
type Layer = { digest: string; size: number; mediaType: string };
const maxMetadataBytes = 1024 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

async function limitedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`下载源返回 HTTP ${response.status}`);
  if (!response.body) throw new Error("下载源未返回文件内容");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("模型配套文件超过允许大小");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

/** Metadata redirects stay on Hugging Face's HTTPS hosts, without browser cookies. */
async function metadataRequest(url: string, signal: AbortSignal, request: ModelMetadataFetch): Promise<Response> {
  let target = new URL(url);
  for (let hop = 0; hop < 8; hop++) {
    if (target.protocol !== "https:" || target.username || target.password ||
      !(target.hostname === "huggingface.co" || target.hostname.endsWith(".huggingface.co") || target.hostname === "hf.co" || target.hostname.endsWith(".hf.co"))) {
      throw new Error("模型配套文件跳转到不受支持的下载地址");
    }
    signal.throwIfAborted();
    const response = await request(target.toString(), { signal, redirect: "manual", credentials: "omit" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("模型下载源缺少跳转地址");
    target = new URL(location, target);
  }
  throw new Error("模型下载源跳转次数过多");
}

function manifestLayers(value: unknown): Layer[] {
  const manifest = value as { schemaVersion?: unknown; layers?: unknown; config?: unknown } | null;
  if (manifest?.schemaVersion !== 2 || !Array.isArray(manifest.layers) || manifest.layers.length > 256 || !manifest.config) throw new Error("Hugging Face 模型清单格式无效");
  const layers = new Map<string, Layer>();
  for (const item of [...manifest.layers, manifest.config]) {
    const layer = item as Layer | null;
    if (!layer || typeof layer.digest !== "string" || !digestPattern.test(layer.digest) || !Number.isSafeInteger(layer.size) || layer.size <= 0 ||
      typeof layer.mediaType !== "string" || (!layer.mediaType.startsWith("application/vnd.ollama.image.") && layer.mediaType !== "application/vnd.docker.container.image.v1+json")) throw new Error("Hugging Face 模型文件信息无效");
    if (layers.has(layer.digest) && layers.get(layer.digest)!.size !== layer.size) throw new Error("Hugging Face 模型文件大小不一致");
    layers.set(layer.digest, layer);
  }
  if (!Number.isSafeInteger([...layers.values()].reduce((sum, layer) => sum + layer.size, 0))) throw new Error("Hugging Face 模型文件大小无效");
  return [...layers.values()];
}

/**
 * Ollama 0.35's redirected blob transport bypasses environment proxies. Use the
 * app's existing network session for small companion files, then let Ollama own
 * weight transfer/resumption and model registration. Never rewrite model files,
 * remove shared cache, or change proxy settings. The public blob API verifies SHA.
 */
export async function prepareHuggingFaceMetadata(model: string, client: Pick<OllamaClient, "hasBlob" | "cacheBlob">, options: {
  signal: AbortSignal; request: ModelMetadataFetch; receive(chunk: OllamaChunk): void; plan(layers: { digest: string; total: number }[]): void;
}): Promise<void> {
  if (!model.toLowerCase().startsWith("hf.co/")) return;
  const match = /^hf\.co\/([^/]+)\/([^/:]+)(?::([^:]+))?$/iu.exec(model);
  if (!validLocalModelName(model) || !match) throw new Error("请使用 hf.co/作者/仓库:量化 格式的模型名称");
  const base = `https://huggingface.co/v2/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
  const bounded = (): AbortSignal => AbortSignal.any([options.signal, AbortSignal.timeout(45000)]);
  options.signal.throwIfAborted();
  const response = await metadataRequest(`${base}/manifests/${encodeURIComponent(match[3] ?? "latest")}`, bounded(), options.request);
  const layers = manifestLayers(JSON.parse(new TextDecoder().decode(await limitedBytes(response, maxMetadataBytes))));
  options.plan(layers.map((layer) => ({ digest: layer.digest, total: layer.size })));
  for (const layer of layers) {
    options.signal.throwIfAborted();
    if (layer.mediaType === "application/vnd.ollama.image.model") {
      if (await client.hasBlob(layer.digest, options.signal)) options.receive({ status: "pulling cached model", digest: layer.digest, completed: layer.size, total: layer.size });
      continue;
    }
    if (layer.size > maxMetadataBytes) throw new Error("模型配套文件超过 1 MB，暂不支持通过此通路下载");
    const kind = layer.mediaType.endsWith(".license") ? "license" : layer.mediaType.endsWith(".template") ? "template" : "config";
    const status = `pulling metadata ${kind}`;
    options.receive({ status, digest: layer.digest, total: layer.size, completed: 0 });
    if (!await client.hasBlob(layer.digest, options.signal)) {
      const file = await metadataRequest(`${base}/blobs/${layer.digest}`, bounded(), options.request);
      const bytes = await limitedBytes(file, layer.size);
      if (bytes.byteLength !== layer.size || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== layer.digest) throw new Error("模型配套文件校验失败，未写入缓存，请重试");
      options.signal.throwIfAborted();
      await client.cacheBlob(layer.digest, bytes, options.signal);
    }
    options.receive({ status, digest: layer.digest, completed: layer.size, total: layer.size });
  }
  options.receive({ status: "preparing model" });
}
