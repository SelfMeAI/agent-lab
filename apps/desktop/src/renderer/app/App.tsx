import { useEffect, useState, type CSSProperties, type JSX } from "react";
import type { AppInfo } from "../../../../../packages/contracts/src/index";
import { isAgentRuntimeId } from "../../../../../packages/contracts/src/index";
import { LabPage } from "../labs/LabPage";
import { HomePage } from "../shell/HomePage";
import { SettingsPanel } from "../shell/SettingsPanel";
import { TopBar } from "../shell/TopBar";
import { attachAgentEvents } from "../labs/agent-lab/agent-store";
import { attachLocalModelEvents } from "../labs/local-model-lab/local-model-store";
import { LocalModelSettings } from "../labs/local-model-lab/Dialogs";
import { goHome, goToLab, parseHash } from "./navigation";
import starfield from "../../../../../assets/backgrounds/lab-space.png";

export function App(): JSX.Element {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [providerRevision, setProviderRevision] = useState(0);
  const agentWorkspace = route.lab?.id === "agent-lab" && isAgentRuntimeId(route.viewId);
  const jevWorkspace = route.lab?.id === "jev-lab" && route.viewId === "xiangqi";
  const jevExperiment = route.lab?.id === "jev-lab" && Boolean(route.viewId) && route.viewId !== "xiangqi";
  const jevView = jevWorkspace || jevExperiment;
  const localModelView = route.lab?.id === "local-model-lab";
  const remoteView = route.lab?.id === "remote-agent-lab";
  const indexView = !route.lab || (!route.viewId && !localModelView);
  const macDesktop = Boolean(window.agentLab) && /Macintosh/.test(navigator.userAgent);

  useEffect(() => {
    const syncRoute = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", syncRoute);
    if (window.agentLab) {
      void window.agentLab.getAppInfo().then(setInfo).catch(() => setInfo(null));
    }
    const detachAgents = attachAgentEvents();
    const detachLocalModels = attachLocalModelEvents();
    return () => { window.removeEventListener("hashchange", syncRoute); detachAgents(); detachLocalModels(); };
  }, []);

  return (
    <div className={`app-shell${macDesktop ? " app-shell--mac" : ""}`} style={{ "--space-art": `url(${starfield})` } as CSSProperties}>
      <TopBar inLab={Boolean(route.lab)} showSettings={agentWorkspace || jevView || localModelView} onBack={() => localModelView ? goHome() : route.lab && route.viewId ? goToLab(route.lab.id) : goHome()} onOpenSettings={() => setSettingsOpen(true)} />
      <div className={`app-viewport${indexView ? " app-viewport--index" : ""}${agentWorkspace ? " app-viewport--workspace" : ""}${jevWorkspace ? " app-viewport--jev-workspace" : ""}${jevExperiment ? " app-viewport--jev-experiment" : ""}${localModelView ? " app-viewport--local-model" : ""}${remoteView ? " app-viewport--remote" : ""}`} key={`${route.lab?.id ?? "home"}:${route.viewId ?? "index"}`}>
        {route.lab ? <LabPage lab={route.lab} viewId={route.viewId} onOpenSettings={() => setSettingsOpen(true)} providerRevision={providerRevision} /> : <HomePage />}
      </div>
      {settingsOpen && (localModelView ? <LocalModelSettings onClose={() => setSettingsOpen(false)} /> : <SettingsPanel info={info} runtimeId={route.lab?.id === "agent-lab" ? route.viewId : jevView ? "jev" : undefined} onClose={() => setSettingsOpen(false)} onProviderSaved={() => setProviderRevision((value) => value + 1)} />)}
    </div>
  );
}
