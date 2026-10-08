import type { LocalModelDetails, LocalModelInfo, LocalModelParameters } from "../../contracts/src/local-model";

export type OllamaChunk = {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  error?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
  status?: string;
  digest?: string;
  completed?: number;
  total?: number;
};

export function validLocalModelName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$/u.test(value) && !value.includes("..") && !/(?:cloud|remote)$/iu.test(value);
}

/** Registry names and GGUF quantization tags are case-insensitive; absent tags use latest. */
export function sameLocalModel(a: string, b: string): boolean {
  const canonical = (name: string): string => (name.includes(":") ? name : `${name}:latest`).toLowerCase();
  return canonical(a) === canonical(b);
}

export function ollamaError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/requires more|out of memory|insufficient|unable to allocate/iu.test(text)) return "模型所需内存超过当前可用容量，请选择更小的模型或减少上下文长度。";
  if (/not found|does not exist|pull model manifest.*not/iu.test(text)) return "未找到该模型，请检查名称和版本，或先下载模型。";
  if (/unknown (?:model )?architecture|unsupported (?:model|architecture)|not supported.*architecture/iu.test(text)) return "内置运行时暂不支持该模型架构，请选择其他型号；更换量化版本不一定能解决。";
  if (/unauthorized|forbidden|access denied|status code: (?:401|403)/iu.test(text)) return "模型源拒绝访问。请确认该模型为公开模型且网络可访问；此面板暂不支持需要账号授权的下载。";
  if (/no space left|disk full/iu.test(text)) return "磁盘空间不足，请释放空间或更换模型存储目录后重试。";
  if (/unexpected EOF|TLS handshake|no such host|connection timed out/iu.test(text)) return "连接模型下载源失败，请检查网络后重试，已保存的分片可继续使用。";
  if (/ECONNREFUSED|fetch failed|socket|connection reset/iu.test(text)) return "本地模型服务连接中断，请重试。";
  if (/timed out|timeout/iu.test(text)) return "本地模型响应超时，请重试或选择更小的模型。";
  return text;
}

/** Handles arbitrary UTF-8/network chunk boundaries and the final unterminated line. */
export async function readOllamaStream(response: Response, receive: (value: OllamaChunk) => void): Promise<void> {
  if (!response.body) throw new Error("本地模型未返回输出流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (line: string): void => {
    if (!line.trim()) return;
    const value = JSON.parse(line) as OllamaChunk;
    if (value.error) throw new Error(value.error);
    receive(value);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error("本地模型返回的单段数据过大");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    }
    buffer += decoder.decode();
    consume(buffer);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class OllamaClient {
  constructor(readonly endpoint: string) {
    const url = new URL(endpoint);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("内置模型服务必须运行在本机");
  }

  private async request(path: string, body?: unknown, signal?: AbortSignal, method?: string): Promise<Response> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(ollamaError(payload.error ?? `Ollama HTTP ${response.status}`));
    }
    return response;
  }

  async version(signal?: AbortSignal): Promise<string> {
    const value = await (await this.request("/api/version", undefined, signal)).json() as { version: string };
    return value.version;
  }

  async models(): Promise<LocalModelInfo[]> {
    const [installed, running] = await Promise.all([
      (await this.request("/api/tags")).json() as Promise<{ models?: Array<{ name: string; digest: string; size: number; remote_host?: string; details?: { parameter_size?: string; quantization_level?: string } }> }>,
      (await this.request("/api/ps")).json() as Promise<{ models?: Array<{ name: string; size?: number; size_vram?: number }> }>,
    ]);
    return (installed.models ?? []).filter((item) => !item.remote_host && validLocalModelName(item.name)).map((item) => ({
      name: item.name, digest: item.digest, size: item.size,
      parameterSize: item.details?.parameter_size ?? "—", quantization: item.details?.quantization_level ?? "—",
      loaded: (running.models ?? []).some((model) => model.name === item.name),
      memoryBytes: (running.models ?? []).find((model) => model.name === item.name)?.size ?? null,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async details(model: string, signal?: AbortSignal): Promise<LocalModelDetails> {
    const payload = await (await this.request("/api/show", { model }, signal)).json() as { capabilities?: string[]; model_info?: Record<string, unknown>; thinking?: { levels?: string[] }; remote_host?: string };
    if (payload.remote_host) throw new Error("此实验台仅运行本地模型");
    const context = Object.entries(payload.model_info ?? {}).find(([key]) => key.endsWith(".context_length"))?.[1];
    return { capabilities: payload.capabilities ?? [], contextLength: typeof context === "number" ? context : null, thinkingLevels: payload.thinking?.levels ?? [] };
  }

  async chat(model: string, prompt: string, systemPrompt: string, parameters: LocalModelParameters, signal: AbortSignal, receive: (value: OllamaChunk) => void, unloadAfter: boolean): Promise<void> {
    const details = await this.details(model, signal);
    signal.throwIfAborted();
    if (!details.capabilities.includes("completion")) throw new Error("该模型不支持文本生成，请选择文本模型");
    if (details.contextLength !== null && parameters.contextLength > details.contextLength) throw new Error(`该模型最大上下文为 ${details.contextLength}，请调整上下文长度`);
    const response = await this.request("/api/chat", {
      model, stream: true, messages: [...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []), { role: "user", content: prompt }],
      keep_alive: unloadAfter ? 0 : "5m",
      ...(parameters.thinking === "off" && details.capabilities.includes("thinking") ? { think: false } : {}),
      options: { temperature: parameters.temperature, num_ctx: parameters.contextLength, num_predict: parameters.maxTokens, ...(parameters.seed === null ? {} : { seed: parameters.seed }) },
    }, signal);
    let finished = false;
    await readOllamaStream(response, (value) => { if (value.done) finished = true; receive(value); });
    if (!finished) throw new Error("本地模型输出意外中断，未收到完成标记");
  }

  async pull(model: string, signal: AbortSignal, receive: (value: OllamaChunk) => void): Promise<void> {
    let finished = false;
    await readOllamaStream(await this.request("/api/pull", { model, stream: true }, signal), (value) => { if (value.status === "success") finished = true; receive(value); });
    if (!finished) throw new Error("模型下载中断，尚未完成验证");
  }

  async hasBlob(digest: string, signal: AbortSignal): Promise<boolean> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("模型文件摘要无效");
    const response = await fetch(`${this.endpoint}/api/blobs/${digest}`, { method: "HEAD", signal });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`读取模型缓存失败：HTTP ${response.status}`);
    return true;
  }

  async cacheBlob(digest: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("模型文件摘要无效");
    const response = await fetch(`${this.endpoint}/api/blobs/${digest}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(bytes).buffer, signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error ?? `保存模型缓存失败：HTTP ${response.status}`);
    }
    await response.body?.cancel();
  }

  async unload(model: string): Promise<void> { await this.request("/api/generate", { model, keep_alive: 0 }, AbortSignal.timeout(30000)); }
  async remove(model: string): Promise<void> { await this.request("/api/delete", { model }, undefined, "DELETE"); }
}
