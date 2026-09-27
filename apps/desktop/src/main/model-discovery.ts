const maxResponseBytes = 2 * 1024 * 1024;

export function modelListUrl(baseUrl: string, protocol: "openai" | "anthropic" = "openai"): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error("请填写有效的 API 根地址");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("API 地址必须是不含查询参数的 http(s) 根地址");
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (/\/(?:chat\/completions|responses|models|messages)$/u.test(path)) throw new Error("请填写 API 根地址，不要包含具体接口路径");
  url.pathname = `${path}${protocol === "anthropic" && !path.endsWith("/v1") ? "/v1" : ""}/models`;
  return url.toString();
}

export async function discoverModels(baseUrl: string, apiKey: string, protocol: "openai" | "anthropic" = "openai", request: (url: string, options?: RequestInit) => Promise<Response> = fetch): Promise<string[]> {
  const key = apiKey.trim();
  if (!key || key.length > 4096 || /[\r\n\0]/u.test(key)) throw new Error("请填写有效的 API Key");
  const endpoint = modelListUrl(baseUrl, protocol);
  let response: Response;
  try {
    response = await request(endpoint, {
      headers: protocol === "anthropic" ? { Authorization: `Bearer ${key}`, "x-api-key": key, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new Error("获取模型列表超时");
    throw new Error("无法连接模型列表接口");
  }
  if (!response.ok) throw new Error(`模型列表接口返回 HTTP ${response.status}`);
  if (!response.body) throw new Error("模型列表接口未返回内容");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes) throw new Error("模型列表过大，请手动填写模型 ID");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("接口未返回标准模型列表，请手动填写模型 ID");
  }
  const data = payload && typeof payload === "object" && "data" in payload ? payload.data : undefined;
  if (!Array.isArray(data)) throw new Error("接口未返回标准模型列表，请手动填写模型 ID");
  return [...new Set(data.map((item: unknown) => item && typeof item === "object" && "id" in item ? item.id : undefined)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\r\n\0]/u.test(id)))].sort((left, right) => left.localeCompare(right));
}
