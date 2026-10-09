import type { RemoteAgentId, RemoteModelConnection, RemoteModelInput } from "../../contracts/src/remote-agent";
import { openClawRpc, type OpenClawIdentity } from "./openclaw/gateway";
import { remoteEndpoint } from "./transport/endpoint";

export function validateRemoteModel(value: RemoteModelInput): RemoteModelInput {
  if (!value || !["openai", "anthropic"].includes(value.protocol)) throw new Error("请选择模型协议");
  const url = new URL(value.baseUrl?.trim());
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("模型地址需要 HTTP(S)，不能包含凭据或查询参数");
  const model = value.model?.trim();
  if (!model || model.length > 200 || /[\s\x00-\x1f]/.test(model)) throw new Error("请填写有效的 Model ID");
  if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || value.apiKey.length > 8192 || /[\r\n\x00]/.test(value.apiKey))) throw new Error("API Key 格式无效");
  return { protocol: value.protocol, baseUrl: url.toString().replace(/\/+$/, ""), model, apiKey: value.apiKey?.trim() || undefined };
}

type Settings = { agent_settings?: { llm?: { model?: string; base_url?: string } }; llm_api_key_is_set?: boolean };
type ClawConfig = { hash?: string; config?: { agents?: { defaults?: { model?: { primary?: string } } }; models?: { providers?: Record<string, { baseUrl?: string; apiKey?: unknown; api?: string; models?: Array<{ id: string; name: string }> }> } } };

/** Native persistence is authoritative. Model secrets never become a renderer response. */
export class RemoteModelClient {
  constructor(private readonly engine: RemoteAgentId, private readonly endpoint: () => Promise<string>,
    private readonly credentials: () => Promise<{ sessionApiKey: string; device?: OpenClawIdentity }>) {}

  private async hands<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const endpoint = remoteEndpoint(await this.endpoint(), true);
    const keys = await this.credentials();
    const response = await fetch(`${endpoint}${path}`, { method, headers: { "X-Session-API-Key": keys.sessionApiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`OpenHands 设置${method === "GET" ? "读取" : "保存"}失败（${response.status}）`);
    return response.json() as Promise<T>;
  }
  private async claw<T>(method: string, params: unknown = {}): Promise<T> {
    const endpoint = await this.endpoint(); const keys = await this.credentials();
    if (!keys.device) throw new Error("OpenClaw 设备身份缺失");
    return openClawRpc(endpoint, keys.sessionApiKey, keys.device, method, params);
  }
  async get(): Promise<RemoteModelConnection> {
    if (this.engine === "openhands") return this.handsConnection(await this.hands<Settings>("/api/settings"));
    return this.clawConnection(await this.claw<ClawConfig>("config.get"));
  }
  private handsConnection(settings: Settings): RemoteModelConnection {
    const llm = settings.agent_settings?.llm;
    const model = llm?.model ?? "";
    return { protocol: model.startsWith("anthropic/") ? "anthropic" : "openai", baseUrl: llm?.base_url ?? "",
      model: model.replace(/^(?:openai|anthropic)\//, ""), configured: settings.llm_api_key_is_set === true };
  }
  private clawConnection(snapshot: ClawConfig): RemoteModelConnection {
    const provider = snapshot.config?.models?.providers?.["selfme"];
    const primary = snapshot.config?.agents?.defaults?.model?.primary;
    return { protocol: provider?.api === "anthropic-messages" ? "anthropic" : "openai", baseUrl: provider?.baseUrl ?? "",
      model: primary?.startsWith("selfme/") ? primary.slice(7) : provider?.models?.[0]?.id ?? "", configured: Boolean(provider?.apiKey) };
  }
  async save(input: RemoteModelInput): Promise<RemoteModelConnection> {
    const value = validateRemoteModel(input);
    const previous = await this.get();
    if (!previous.configured && !value.apiKey) throw new Error("请填写 API Key");
    if (this.engine === "openhands") {
      return this.handsConnection(await this.hands<Settings>("/api/settings", "PATCH", { agent_settings_diff: { llm: {
        model: `${value.protocol}/${value.model}`, base_url: value.baseUrl, ...(value.apiKey ? { api_key: value.apiKey } : {}),
      } } }));
    }
    const snapshot = await this.claw<ClawConfig>("config.get");
    if (!snapshot.hash) throw new Error("OpenClaw 未返回配置版本，未写入设置");
    const model = { id: value.model, name: value.model, input: ["text"] };
    const patch = { models: { providers: { selfme: { baseUrl: value.baseUrl,
      api: value.protocol === "anthropic" ? "anthropic-messages" : "openai-completions",
      ...(value.apiKey ? { apiKey: value.apiKey } : {}), models: [model] } } }, agents: { defaults: { model: { primary: `selfme/${value.model}` } } } };
    await this.claw("config.patch", { raw: JSON.stringify(patch), baseHash: snapshot.hash });
    // config.patch can legitimately reload the gateway; the write acknowledgement
    // is authoritative. A later GET verifies native state without duplicate writes.
    return { protocol: value.protocol, baseUrl: value.baseUrl, model: value.model, configured: true };
  }
}
