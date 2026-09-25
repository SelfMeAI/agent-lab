import { useEffect, useState, type CSSProperties, type JSX } from "react";
import type { AppInfo } from "../../../../../packages/contracts/src/index";
import { LabPage } from "../labs/LabPage";
import { AtlasPage } from "../atlas/AtlasPage";
import { HomePage } from "../shell/HomePage";
import { SettingsPanel } from "../shell/SettingsPanel";
import { TopBar } from "../shell/TopBar";
import { attachAgentEvents } from "../labs/agent-lab/agent-store";
import { goHome, goToLab, parseHash } from "./navigation";
import starfield from "../../../../../assets/backgrounds/lab-space.png";

export function App(): JSX.Element {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [providerRevision, setProviderRevision] = useState(0);
  const agentWorkspace = route.lab?.id === "agent-lab" && (route.viewId === "dsh" || route.viewId === "codex" || route.viewId === "pi" || route.viewId === "kimi-code");
  const jevWorkspace = route.lab?.id === "jev-lab" && route.viewId === "xiangqi";
  const macDesktop = Boolean(window.selfmeLab) && /Macintosh/.test(navigator.userAgent);

  useEffect(() => {
    const syncRoute = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", syncRoute);
    if (window.selfmeLab) {
      void window.selfmeLab.getAppInfo().then(setInfo).catch(() => setInfo(null));
    }
    const detachAgents = attachAgentEvents();
    return () => { window.removeEventListener("hashchange", syncRoute); detachAgents(); };
  }, []);

  return (
    <div className={`app-shell${macDesktop ? " app-shell--mac" : ""}`} style={{ "--space-art": `url(${starfield})` } as CSSProperties}>
      <TopBar inLab={Boolean(route.lab || route.atlas)} showSettings={(route.lab?.id === "agent-lab" && (route.viewId === "dsh" || route.viewId === "codex" || route.viewId === "pi" || route.viewId === "kimi-code")) || (route.lab?.id === "jev-lab" && route.viewId === "xiangqi")} onBack={() => route.lab && route.viewId ? goToLab(route.lab.id) : goHome()} onOpenSettings={() => setSettingsOpen(true)} />
      <div className={`app-viewport${agentWorkspace ? " app-viewport--workspace" : ""}${jevWorkspace ? " app-viewport--jev-workspace" : ""}`} key={`${route.atlas ? "atlas" : route.lab?.id ?? "home"}:${route.viewId ?? "index"}`}>
        {route.atlas ? <AtlasPage /> : route.lab ? <LabPage lab={route.lab} viewId={route.viewId} onOpenSettings={() => setSettingsOpen(true)} providerRevision={providerRevision} /> : <HomePage />}
      </div>
      {settingsOpen && <SettingsPanel info={info} runtimeId={route.lab?.id === "agent-lab" ? route.viewId : route.lab?.id === "jev-lab" && route.viewId === "xiangqi" ? "jev" : undefined} onClose={() => setSettingsOpen(false)} onProviderSaved={() => setProviderRevision((value) => value + 1)} />}
    </div>
  );
}
