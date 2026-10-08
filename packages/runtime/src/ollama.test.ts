import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaClient, readOllamaStream, validLocalModelName, ollamaError, type OllamaChunk } from "./ollama";
const parameters = { temperature: 0.7, contextLength: 4096, seed: 42, maxTokens: 64, thinking: "off" as const };
afterEach(() => vi.unstubAllGlobals());
function stream(text: string, split = 7): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split)); controller.close(); } }));
}
describe("embedded Ollama protocol", () => {
  it("decodes split UTF-8, multiple lines and an unterminated final line", async () => {
    const received: OllamaChunk[] = [];
    await readOllamaStream(stream('\n{"message":{"thinking":"想一想"}}\n{"message":{"content":"你好🌍"}}\n{"done":true}', 1), (chunk) => received.push(chunk));
    expect(received.map((v) => v.message?.content ?? v.message?.thinking ?? v.done)).toEqual(["想一想", "你好🌍", true]);
  });
  it("does not hide error frames or malformed output", async () => {
    await expect(readOllamaStream(stream('{"error":"out of memory"}\n'), () => {})).rejects.toThrow("out of memory");
    await expect(readOllamaStream(stream('{broken}\n'), () => {})).rejects.toThrow();
  });
  it("only accepts a loopback runtime and local model names", () => {
    expect(() => new OllamaClient("https://api.example.com")).toThrow();
    expect(() => new OllamaClient("http://localhost:11434")).toThrow();
    for (const name of ["qwen3:0.6b", "gemma3:1b", "org/model:q4_K_M"]) expect(validLocalModelName(name)).toBe(true);
    for (const name of ["../model", "a-cloud", "x:remote", "http://x", "bad name", "a;rm", ""]) expect(validLocalModelName(name)).toBe(false);
  });
  it("sends independent prompts with the exact requested parameters and preserves real metrics", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ capabilities: ["completion", "thinking"], model_info: { "qwen3.context_length": 40960 } }))
      .mockResolvedValueOnce(stream('{"message":{"thinking":"推理","content":"答"}}\n{"done":true,"prompt_eval_count":25,"eval_count":10,"eval_duration":1000000000}'));
    vi.stubGlobal("fetch", fetchMock);
    const values: OllamaChunk[] = [];
    await new OllamaClient("http://127.0.0.1:11434").chat("qwen3:0.6b", "问题", "用中文", parameters, new AbortController().signal, (c) => values.push(c), true);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body).toMatchObject({ model: "qwen3:0.6b", stream: true, think: false, keep_alive: 0, options: { temperature: 0.7, num_ctx: 4096, num_predict: 64, seed: 42 } });
    expect(body.messages).toEqual([{ role: "system", content: "用中文" }, { role: "user", content: "问题" }]);
    expect(values.at(-1)).toMatchObject({ prompt_eval_count: 25, eval_count: 10, eval_duration: 1000000000 });
  });
  it("rejects silent stream truncation and unsupported context size", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ capabilities: ["completion"] })).mockResolvedValueOnce(stream('{"message":{"content":"partial"}}\n'));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaClient("http://127.0.0.1:1");
    await expect(client.chat("a", "p", "", parameters, new AbortController().signal, () => {}, false)).rejects.toThrow("完成标记");
    fetchMock.mockResolvedValueOnce(Response.json({ capabilities: ["completion"], model_info: { "test.context_length": 1024 } }));
    await expect(client.chat("a", "p", "", parameters, new AbortController().signal, () => {}, false)).rejects.toThrow("1024");
  });
  it("merges installed and memory-resident states without listing cloud models", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ models: [{ name: "a:latest", digest: "abc", size: 1000, details: { parameter_size: "1B", quantization_level: "Q4" } }, { name: "x:cloud" }] }))
      .mockResolvedValueOnce(Response.json({ models: [{ name: "a:latest", size: 2000, size_vram: 1500 }] })));
    expect(await new OllamaClient("http://127.0.0.1:1").models()).toEqual([{ name: "a:latest", digest: "abc", size: 1000, parameterSize: "1B", quantization: "Q4", loaded: true, memoryBytes: 2000 }]);
  });
  it("download requires a success marker, server errors remain visible", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(stream('{"status":"pulling","completed":10,"total":100}')).mockResolvedValueOnce(Response.json({ error: "model not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaClient("http://127.0.0.1:1");
    await expect(client.pull("a", new AbortController().signal, () => {})).rejects.toThrow("验证");
    await expect(client.pull("bad", new AbortController().signal, () => {})).rejects.toThrow("未找到");
    expect(ollamaError(new Error("requires more system memory"))).toContain("内存");
  });
  it("uses only the local runtime's blob API and propagates storage or hash failures", async () => {
    const digest = `sha256:${"a".repeat(64)}`, signal = new AbortController().signal;
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 })).mockResolvedValueOnce(Response.json({ error: "digest mismatch" }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock); const client = new OllamaClient("http://127.0.0.1:1");
    expect(await client.hasBlob(digest, signal)).toBe(false); expect(await client.hasBlob(digest, signal)).toBe(true);
    await client.cacheBlob(digest, new Uint8Array([1, 2]), signal);
    expect(fetchMock.mock.calls[2][0]).toBe(`http://127.0.0.1:1/api/blobs/${digest}`);
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/octet-stream" }, signal });
    await expect(client.cacheBlob(digest, new Uint8Array([1]), signal)).rejects.toThrow("digest mismatch");
    await expect(client.hasBlob("../private", signal)).rejects.toThrow("摘要无效"); expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
