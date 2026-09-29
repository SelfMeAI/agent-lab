export type JevProviderConnection = { baseUrl: string; model: string; apiKey?: string };

export type JevQuestion =
  | { type: "choice"; instructions: string | Record<string, unknown>; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

export interface JevSystemOneRequest {
  model: string;
  state: string | Record<string, unknown>;
  questions: Record<string, JevQuestion>;
}

function apiError(status: number): Error {
  if (status === 401 || status === 403) return new Error("JEV 密钥无效或当前账户无权调用模型");
  if (status === 429) return new Error("JEV 请求过于频繁，请稍后重试");
  return new Error(`JEV 服务返回 HTTP ${status}`);
}

export async function postJevSystemOne<T>(provider: JevProviderConnection, body: JevSystemOneRequest): Promise<T> {
  if (!provider.apiKey) throw new Error("请先配置 JEV API Key");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${provider.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw apiError(response.status);
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("JEV 响应格式无效");
    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("JEV 请求超时，请稍后重试");
    if (error instanceof Error) throw new Error(error.message.replaceAll(provider.apiKey, "[redacted]"));
    throw new Error("JEV 请求失败");
  } finally {
    clearTimeout(timer);
  }
}
