import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import type { AppInfo, ProviderStatus } from "../../../../../packages/contracts/src/index";
import { isAgentRuntimeId } from "../../../../../packages/contracts/src/index";

interface SettingsPanelProps {
  info: AppInfo | null;
  runtimeId?: string;
  onClose(): void;
  onProviderSaved(): void;
}

export function SettingsPanel({ info, runtimeId, onClose, onProviderSaved }: SettingsPanelProps): JSX.Element {
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState(runtimeId === "claude-code" ? "https://api.anthropic.com" : "https://api.deepseek.com");
  const [model, setModel] = useState(runtimeId === "claude-code" ? "claude-sonnet-4-6" : "gpt-5.6");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [modelListOpen, setModelListOpen] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelLookupMessage, setModelLookupMessage] = useState<string | null>(null);
  const modelLookupRevision = useRef(0);
  const hasModelField = isAgentRuntimeId(runtimeId) || runtimeId === "jev";
  const canDiscoverModels = isAgentRuntimeId(runtimeId);
  const matchingModels = models.filter((id) => id.toLowerCase().includes(modelSearch.trim().toLowerCase()));
  useEffect(() => {
    if ((!isAgentRuntimeId(runtimeId) && runtimeId !== "jev") || !window.agentLab) return;
    void window.agentLab.getProviderStatus(runtimeId).then((status) => {
      setProvider(status);
      setBaseUrl(status.baseUrl);
      if (status.model) setModel(status.model);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [runtimeId]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [onClose]);

  function clearModelList(): void {
    modelLookupRevision.current += 1;
    setModels([]);
    setModelListOpen(false);
    setLoadingModels(false);
    setModelLookupMessage(null);
  }

  async function loadModels(): Promise<void> {
    if (!window.agentLab || !canDiscoverModels) return;
    const revision = ++modelLookupRevision.current;
    setLoadingModels(true);
    setModelLookupMessage(null);
    setModelListOpen(false);
    try {
      const found = await window.agentLab.listProviderModels(runtimeId, { baseUrl, apiKey: apiKey.trim() || undefined });
      if (revision !== modelLookupRevision.current) return;
      setModels(found);
      setModelSearch("");
      setModelListOpen(found.length > 0);
      setModelLookupMessage(found.length ? `已获取 ${found.length} 个模型 ID，可搜索选择或继续手填。` : "接口未返回模型，请手动填写模型 ID。");
    } catch (cause) {
      if (revision !== modelLookupRevision.current) return;
      setModels([]);
      setModelLookupMessage(`${cause instanceof Error ? cause.message : String(cause)}；仍可手动填写模型 ID。`);
    } finally {
      if (revision === modelLookupRevision.current) setLoadingModels(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!window.agentLab) return;
    setSaving(true);
    setError(null);
    try {
      const status = await window.agentLab.saveProvider(runtimeId ?? "", { baseUrl, model: hasModelField ? model : undefined, apiKey: apiKey.trim() || undefined });
      setProvider(status);
      setApiKey("");
      onProviderSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <section className="settings-panel" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-panel__heading">
          <h2 id="settings-title">SETTINGS</h2>
          <button onClick={onClose} type="button" aria-label="关闭设置"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" /></svg></button>
        </div>
        <div className="settings-panel__body">
        {hasModelField ? <>
          <div className="settings-panel__intro">
            <span>LOCAL CONFIGURATION</span>
            <div className="settings-panel__title-row">
              <h3>{runtimeId === "dsh" ? "DSH 模型连接" : runtimeId === "codex" ? "Codex 模型连接" : runtimeId === "pi" ? "Pi 模型连接" : runtimeId === "kimi-code" ? "Kimi Code 模型连接" : runtimeId === "qwen-code" ? "Qwen Code 模型连接" : runtimeId === "claude-code" ? "Claude 模型连接" : "JEV 决策连接"}</h3>
              {provider && <small>{provider.configured ? "已配置" : "未配置"}</small>}
            </div>
            <p>填写当前实验要使用的模型连接信息。各实验的设置互不影响。</p>
          </div>
          <form className="settings-panel__form" onSubmit={(event) => void save(event)}>
            <div className="settings-panel__field">
              <label htmlFor="provider-base-url">API BASE URL</label>
              <input id="provider-base-url" onChange={(event) => { setBaseUrl(event.target.value); clearModelList(); }} type="url" value={baseUrl} required spellCheck={false} />
            </div>
            {hasModelField && <div className="settings-panel__field">
              <div className="settings-panel__field-heading">
                <label htmlFor="provider-model">MODEL ID</label>
                {canDiscoverModels && <button className="settings-panel__model-fetch" type="button" onClick={() => void loadModels()} disabled={loadingModels}>{loadingModels ? "获取中…" : "获取模型"}</button>}
              </div>
              <input id="provider-model" onChange={(event) => setModel(event.target.value)} type="text" value={model} required maxLength={256} spellCheck={false} />
              {canDiscoverModels && modelLookupMessage && <span className="settings-panel__field-hint" role="status">{modelLookupMessage}</span>}
              {canDiscoverModels && models.length > 0 && <>
                <button className="settings-panel__model-toggle" type="button" aria-expanded={modelListOpen} onClick={() => setModelListOpen((open) => !open)}>{modelListOpen ? "收起模型列表" : `浏览已获取的模型 · ${models.length}`}</button>
                {modelListOpen && <div className="settings-panel__model-picker">
                  <input aria-label="搜索模型" autoComplete="off" placeholder="搜索模型 ID" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
                  <div className="settings-panel__model-results">
                    {matchingModels.slice(0, 80).map((id) => <button className={id === model ? "is-selected" : ""} key={id} type="button" onClick={() => { setModel(id); setModelListOpen(false); }}>{id}</button>)}
                    {matchingModels.length === 0 && <span>没有匹配的模型，仍可手动填写。</span>}
                    {matchingModels.length > 80 && <span>仅显示前 80 项，输入关键词可缩小范围。</span>}
                  </div>
                </div>}
              </>}
            </div>}
            <div className="settings-panel__field">
              <label htmlFor="provider-api-key">API KEY</label>
              <input autoComplete="off" id="provider-api-key" onChange={(event) => { setApiKey(event.target.value); clearModelList(); }} placeholder={provider?.configured ? "已保存 · 留空保持原密钥" : "输入 API Key"} type="password" value={apiKey} />
              {provider?.configured && <span className="settings-panel__field-hint">无需重新填写已保存的密钥</span>}
            </div>
            <div className="settings-panel__note">
              <strong>连接说明</strong>
              <p>{runtimeId === "claude-code" ? "填写支持 Anthropic Messages 的 API 根地址、Claude 模型 ID 和 API Key。" : canDiscoverModels && runtimeId !== "codex" ? "填写支持 OpenAI Chat Completions 的 API 根地址、模型 ID 和 API Key。" : runtimeId === "codex" ? "填写支持 OpenAI Responses 的 API 根地址、模型 ID 和 API Key。" : "填写 JEV API 根地址，不含 /v1/systemone。"}</p>
              {canDiscoverModels && <p>{runtimeId === "claude-code" ? "API 根地址不要包含 /messages。模型列表仅供选择，能否运行以实际调用为准。" : "API 根地址不要包含 /chat/completions 或 /responses。模型列表仅供选择，能否运行以实际调用为准。"}</p>}
              <p>API Key 会加密保存在本机。以后修改设置时，密钥留空即可保持不变。{runtimeId !== "jev" && "保存后会重新连接。"}</p>
            </div>
            {error && <p className="settings-panel__error" role="alert">{error}</p>}
            <button className="settings-panel__save" disabled={saving} type="submit">{saving ? "保存中…" : runtimeId === "jev" ? "保存设置" : "保存并连接"}</button>
          </form>
        </> : <>
          <p>Agent Lab 桌面实验平台</p>
          <dl><dt>版本</dt><dd>{info?.version ?? "开发预览"}</dd><dt>平台</dt><dd>{info?.platform ?? "Browser preview"}</dd><dt>架构</dt><dd>Electron + TypeScript</dd></dl>
        </>}
        </div>
      </section>
    </div>
  );
}
