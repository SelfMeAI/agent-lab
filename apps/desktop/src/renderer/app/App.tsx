import { useEffect, useState, type CSSProperties, type JSX } from "react";
import type { AppInfo } from "../../../../../packages/contracts/src/index";
import { LabPage } from "../labs/LabPage";
import { HomePage } from "../shell/HomePage";
import { SettingsPanel } from "../shell/SettingsPanel";
import { TopBar } from "../shell/TopBar";
import { parseHash } from "./navigation";
import starfield from "../../../../../assets/backgrounds/lab-space.png";

export function App(): JSX.Element {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    const syncRoute = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", syncRoute);
    if (window.selfmeLab) {
      void window.selfmeLab.getAppInfo().then(setInfo).catch(() => setInfo(null));
    }
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  return (
    <div className="app-shell" style={{ "--space-art": `url(${starfield})` } as CSSProperties}>
      <TopBar inLab={Boolean(route.lab)} onOpenSettings={() => setSettingsOpen(true)} />
      {route.lab ? <LabPage key={route.lab.id} lab={route.lab} viewId={route.viewId} /> : <HomePage />}
      {settingsOpen && <SettingsPanel info={info} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
