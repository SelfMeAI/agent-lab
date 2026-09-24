import { useEffect, useState, type FormEvent, type JSX } from "react";
import type { AppInfo, ProviderStatus } from "../../../../../packages/contracts/src/index";

interface SettingsPanelProps {
  info: AppInfo | null;
  runtimeId?: string;
  onClose(): void;
  onProviderSaved(): void;
}

export function SettingsPanel({ info, runtimeId, onClose, onProviderSaved }: SettingsPanelProps): JSX.Element {
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [model, setModel] = useState("gpt-5.6");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if ((runtimeId !== "dsh" && runtimeId !== "codex" && runtimeId !== "jev") || !window.selfmeLab) return;
    void window.selfmeLab.getProviderStatus(runtimeId).then((status) => {
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

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!window.selfmeLab) return;
    setSaving(true);
    setError(null);
    try {
      const status = await window.selfmeLab.saveProvider(runtimeId ?? "", { baseUrl, model: runtimeId === "codex" || runtimeId === "jev" ? model : undefined, apiKey: apiKey.trim() || undefined });
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
      <section className="settings-panel" onMouseDown={(event) => event.stopPropagation()} aria-label="设置">
        <div className="settings-panel__heading"><h2>SETTINGS</h2><button onClick={onClose} type="button" aria-label="关闭">×</button></div>
        {runtimeId === "dsh" || runtimeId === "codex" || runtimeId === "jev" ? <>
          <p>{runtimeId === "dsh" ? "DSH 模型连接" : runtimeId === "codex" ? "Codex 模型连接" : "JEV 决策连接"}</p>
          <form className="settings-panel__form" onSubmit={(event) => void save(event)}>
            <label htmlFor="dsh-base-url">API BASE URL</label>
            <input id="dsh-base-url" onChange={(event) => setBaseUrl(event.target.value)} type="url" value={baseUrl} required />
            {(runtimeId === "codex" || runtimeId === "jev") && <><label htmlFor="codex-model">MODEL ID</label><input id="codex-model" onChange={(event) => setModel(event.target.value)} type="text" value={model} required /></>}
            <label htmlFor="dsh-api-key">API KEY</label>
            <input autoComplete="off" id="dsh-api-key" onChange={(event) => setApiKey(event.target.value)} placeholder={provider?.configured ? "已保存 · 留空则保持原密钥" : "首次配置请填写"} type="password" value={apiKey} />
            <p className="settings-panel__note">{runtimeId === "dsh" ? "支持 DeepSeek 官方或兼容 DeepSeek Chat Completions 的中转根地址（不要填写 /chat/completions）。" : runtimeId === "codex" ? "Codex 需要兼容 Responses API 的根地址。" : "填写 JEV API 根地址（不含 /v1/systemone）。"}密钥由系统凭据服务加密保存在本机，不回传给页面。{runtimeId !== "jev" && "更改配置会重启当前连接。"}</p>
            {error && <p className="settings-panel__error" role="alert">{error}</p>}
            <button className="settings-panel__save" disabled={saving} type="submit">{saving ? "保存中…" : runtimeId === "jev" ? "保存设置" : "保存并连接"}</button>
          </form>
        </> : <>
          <p>SelfMe Lab 桌面实验平台</p>
          <dl><dt>版本</dt><dd>{info?.version ?? "开发预览"}</dd><dt>平台</dt><dd>{info?.platform ?? "Browser preview"}</dd><dt>架构</dt><dd>Electron + TypeScript</dd></dl>
        </>}
      </section>
    </div>
  );
}
