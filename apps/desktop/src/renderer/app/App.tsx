import { useEffect, useState, type CSSProperties, type JSX } from "react";
import type { AppInfo } from "../../../../../packages/contracts/src/index";
import { LabPage } from "../labs/LabPage";
import { HomePage } from "../shell/HomePage";
import { SettingsPanel } from "../shell/SettingsPanel";
import { TopBar } from "../shell/TopBar";
import { attachDshEvents } from "../labs/agent-lab/dsh-store";
import { goHome, goToLab, parseHash } from "./navigation";
import starfield from "../../../../../assets/backgrounds/lab-space.png";

export function App(): JSX.Element {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [providerRevision, setProviderRevision] = useState(0);

  useEffect(() => {
    const syncRoute = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", syncRoute);
    if (window.selfmeLab) {
      void window.selfmeLab.getAppInfo().then(setInfo).catch(() => setInfo(null));
    }
    const detachDsh = attachDshEvents();
    return () => { window.removeEventListener("hashchange", syncRoute); detachDsh(); };
  }, []);

  return (
    <div className="app-shell" style={{ "--space-art": `url(${starfield})` } as CSSProperties}>
      <TopBar inLab={Boolean(route.lab)} showSettings={route.lab?.id === "agent-lab" && route.viewId === "dsh"} onBack={() => route.lab && route.viewId ? goToLab(route.lab.id) : goHome()} onOpenSettings={() => setSettingsOpen(true)} />
      {route.lab ? <LabPage key={route.lab.id} lab={route.lab} viewId={route.viewId} onOpenSettings={() => setSettingsOpen(true)} providerRevision={providerRevision} /> : <HomePage />}
      {settingsOpen && <SettingsPanel info={info} runtimeId={route.lab?.id === "agent-lab" ? route.viewId : undefined} onClose={() => setSettingsOpen(false)} onProviderSaved={() => setProviderRevision((value) => value + 1)} />}
    </div>
  );
}
