import { useEffect, useState, type CSSProperties, type JSX } from "react";
import type { AppInfo, LabDefinition, LabGroup } from "../../../../packages/contracts/src/index";
import { labById, labs } from "../shared/labs";
import brandMark from "../../../../assets/brand/selfme-lab-mark.png";
import starfield from "../../../../assets/backgrounds/lab-space.png";

const groups: readonly { id: LabGroup; title: string }[] = [
  { id: "runtimes", title: "RUNTIMES" },
  { id: "engines", title: "ENGINES" },
  { id: "studio", title: "STUDIO" },
];

const purposes: Record<string, string> = {
  "agent-lab": "独立接入并观察本地 Harness 的真实工作过程。",
  "remote-agent-lab": "连接自部署的远端 Agent，查看运行与变更。",
  "local-model-lab": "通过 Ollama 测试和对照本地开源模型。",
  "jev-lab": "观察 JEV 在具体测试项中的决策过程。",
  "harness-forge": "设计、运行和对照我们自己的 Harness。",
  "rsi-lab": "在隔离与人工批准下验证 Harness 的自我改进循环。",
  "founder-studio": "沉淀方向、证据、判断和下一步验证。",
};

function routeFromHash(): { lab?: LabDefinition; viewId?: string } {
  const [, category, labId, viewId] = window.location.hash.split("/");
  if (category !== "lab") return {};
  const lab = labById(labId);
  if (!lab) return {};
  return { lab, viewId: lab.views.some((view) => view.id === viewId) ? viewId : undefined };
}

function goHome(): void {
  window.location.hash = "#/";
}

function goToLab(labId: string, viewId?: string): void {
  window.location.hash = viewId ? `#/lab/${labId}/${viewId}` : `#/lab/${labId}`;
}

function Home(): JSX.Element {
  return (
    <main className="home-content">
      <h1 className="page-title">LAB INDEX</h1>
      {groups.map((group) => (
        <section className="lab-group" key={group.id} aria-label={group.title}>
          <div className="group-heading"><h2>{group.title}</h2><span /></div>
          <div className={`lab-grid lab-grid--${group.id}`}>
            {labs.filter((lab) => lab.group === group.id).map((lab) => (
              <button
                className="lab-card"
                data-lab-id={lab.id}
                key={lab.id}
                onClick={() => goToLab(lab.id)}
                style={{ "--accent": lab.accent } as CSSProperties}
                type="button"
              >
                <span className="lab-card__symbol" aria-hidden="true">{lab.symbol}</span>
                <span className="lab-card__title">{lab.title}</span>
                <span className="lab-card__arrow" aria-hidden="true">⟶</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

function LabContent({ lab, viewId }: { lab: LabDefinition; viewId?: string }): JSX.Element {
  const view = lab.views.find((item) => item.id === viewId);
  const [workspace, setWorkspace] = useState<string | null>(null);

  async function selectWorkspace(): Promise<void> {
    if (!window.selfmeLab) return;
    const selected = await window.selfmeLab.chooseWorkspace();
    if (selected) setWorkspace(selected);
  }

  return (
    <main className="lab-content" style={{ "--accent": lab.accent } as CSSProperties}>
      <div className="lab-heading">
        <span className="lab-heading__symbol" aria-hidden="true">{lab.symbol}</span>
        <div>
          <p className="eyebrow">SELFME LAB / EXPERIMENT</p>
          <h1>{lab.title}</h1>
        </div>
      </div>
      {lab.id === "agent-lab" && !view ? (
        <section className="agent-index">
          <div className="section-title"><h2>LOCAL HARNESSES</h2><span>独立实验入口</span></div>
          <div className="agent-grid">
            {lab.views.map((item) => (
              <button className="agent-tile" key={item.id} onClick={() => goToLab(lab.id, item.id)} type="button">
                <span>{item.label}</span><span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <>
          {lab.views.length > 1 && (
            <nav className="lab-tabs" aria-label={`${lab.title} 界面`}>
              {lab.views.map((item) => (
                <button
                  className={item.id === (view?.id ?? lab.views[0].id) ? "is-active" : ""}
                  key={item.id}
                  onClick={() => goToLab(lab.id, item.id)}
                  type="button"
                >{item.label}</button>
              ))}
            </nav>
          )}
          <section className="module-frame">
            <div className="module-frame__topline">
              <span>{view?.label.toUpperCase() ?? lab.views[0].label.toUpperCase()}</span>
              <span>DESIGN APPROVED / INTEGRATION PENDING</span>
            </div>
            <div className="module-frame__body">
              <p className="module-kicker">FRAMEWORK READY</p>
              <h2>这个实验尚未接入运行时</h2>
              <p>{purposes[lab.id]}</p>
              <p className="module-note">当前界面只确认模块、导航与桌面边界。接入并验收真实运行后，才会显示对话、指标或产物。</p>
              {lab.id === "agent-lab" && (
                <div className="workspace-control">
                  <button onClick={() => void selectWorkspace()} type="button">选择工作目录 ↗</button>
                  <span title={workspace ?? undefined}>{workspace ?? "尚未选择工作目录"}</span>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

export function App(): JSX.Element {
  const [route, setRoute] = useState(routeFromHash);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    const syncRoute = (): void => setRoute(routeFromHash());
    window.addEventListener("hashchange", syncRoute);
    void window.selfmeLab?.getAppInfo().then(setInfo).catch(() => setInfo(null));
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  return (
    <div className="app-shell" style={{ "--space-art": `url(${starfield})` } as CSSProperties}>
      <header className="topbar">
        <button className="brand" onClick={goHome} type="button" aria-label="返回 SelfMe Lab 首页">
          <img src={brandMark} alt="" /><span>SELFME LAB</span>
        </button>
        <div className="topbar-actions">
          {route.lab && <button className="icon-button" onClick={goHome} type="button" aria-label="返回首页">←</button>}
          <button className="icon-button" onClick={() => setSettingsOpen(true)} type="button" aria-label="设置">☷</button>
        </div>
      </header>
      {route.lab ? <LabContent key={route.lab.id} lab={route.lab} viewId={route.viewId} /> : <Home />}
      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)} role="presentation">
          <section className="settings-panel" onMouseDown={(event) => event.stopPropagation()} aria-label="设置">
            <div className="settings-panel__heading"><h2>SETTINGS</h2><button onClick={() => setSettingsOpen(false)} type="button" aria-label="关闭">×</button></div>
            <p>SelfMe Lab 桌面框架</p>
            <dl><dt>版本</dt><dd>{info?.version ?? "开发预览"}</dd><dt>平台</dt><dd>{info?.platform ?? "Browser preview"}</dd><dt>架构</dt><dd>Electron + TypeScript</dd></dl>
            <p className="settings-panel__note">模型凭据、运行时安装与实验配置会随各模块的真实接入逐步开放。</p>
          </section>
        </div>
      )}
    </div>
  );
}
