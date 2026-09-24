import type { JSX } from "react";
import type { AppInfo } from "../../../../../packages/contracts/src/index";

interface SettingsPanelProps {
  info: AppInfo | null;
  onClose(): void;
}

export function SettingsPanel({ info, onClose }: SettingsPanelProps): JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <section className="settings-panel" onMouseDown={(event) => event.stopPropagation()} aria-label="设置">
        <div className="settings-panel__heading"><h2>SETTINGS</h2><button onClick={onClose} type="button" aria-label="关闭">×</button></div>
        <p>SelfMe Lab 桌面框架</p>
        <dl><dt>版本</dt><dd>{info?.version ?? "开发预览"}</dd><dt>平台</dt><dd>{info?.platform ?? "Browser preview"}</dd><dt>架构</dt><dd>Electron + TypeScript</dd></dl>
        <p className="settings-panel__note">模型凭据、运行时安装与实验配置会随各模块的真实接入逐步开放。</p>
      </section>
    </div>
  );
}
