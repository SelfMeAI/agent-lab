import { describe, expect, it } from "vitest";
import { applicationMenuTemplate } from "./application-menu";

describe("full project name in native application menus", () => {
  it("does not derive About/Hide/Quit labels from the legacy crypto name", () => {
    const menu = applicationMenuTemplate("darwin");
    expect(menu[0].label).toBe("Agent Lab");
    const children = menu[0].submenu as Array<{ role?: string; label?: string }>;
    expect(children.filter(item => item.label).map(item => item.label)).toEqual(["About Agent Lab", "Hide Agent Lab", "Quit Agent Lab"]);
    expect(JSON.stringify(menu)).not.toContain("SelfMe");
    expect(children.filter(item => item.label).every(item => item.label?.endsWith("Agent Lab"))).toBe(true);
  });
  it("keeps conventional platform menu roles without a macOS-only app menu elsewhere", () => {
    expect(applicationMenuTemplate("win32").map(item => item.role)).toEqual(["fileMenu", "editMenu", "viewMenu", "windowMenu"]);
  });
});
