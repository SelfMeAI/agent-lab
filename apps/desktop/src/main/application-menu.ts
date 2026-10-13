import type { MenuItemConstructorOptions } from "electron";
import { applicationName } from "./application-identity";

/** Display branding is independent of the retained OS encryption identity. */
export function applicationMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  return [
    ...(platform === "darwin" ? [{ label: applicationName, submenu: [
      { role: "about" as const, label: `About ${applicationName}` },
      { type: "separator" as const },
      { role: "services" as const },
      { type: "separator" as const },
      { role: "hide" as const, label: `Hide ${applicationName}` },
      { role: "hideOthers" as const },
      { role: "unhide" as const },
      { type: "separator" as const },
      { role: "quit" as const, label: `Quit ${applicationName}` },
    ] }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
