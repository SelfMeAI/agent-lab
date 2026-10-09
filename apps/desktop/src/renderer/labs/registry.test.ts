import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseHash } from "../app/navigation";
import { labs } from "./registry";

interface Catalog {
  screens: Array<{ id: string; file: string; status?: "superseded"; role?: "supporting" }>;
}

const designRoot = new URL("../../../../../design/", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("catalog.json", designRoot), "utf8")) as Catalog;

describe("lab modules and approved designs", () => {
  it("keeps every lab and view identifier unique", () => {
    expect(new Set(labs.map((lab) => lab.id)).size).toBe(labs.length);
    expect(new Set(catalog.screens.map((screen) => screen.id)).size).toBe(catalog.screens.length);
    expect(new Set(catalog.screens.map((screen) => screen.file)).size).toBe(catalog.screens.length);
    for (const lab of labs) {
      expect(new Set(lab.views.map((view) => view.id)).size).toBe(lab.views.length);
    }
  });

  it("maps each view to an existing approved mockup", () => {
    const approved = catalog.screens.filter(screen => screen.status !== "superseded" && screen.role !== "supporting");
    const files = new Map(approved.map((screen) => [screen.id, screen.file]));
    const designIds = new Set(labs.flatMap((lab) => lab.views.filter(view => view.designStatus !== "pending").map((view) => view.designId)));
    designIds.add("home.index");
    designIds.add("agent.index");
    designIds.add("remote.index");
    expect(designIds.size).toBe(approved.length);
    for (const designId of designIds) {
      const file = files.get(designId);
      expect(file, `Missing catalog entry for ${designId}`).toBeDefined();
      expect(existsSync(new URL(file!, designRoot)), `Missing mockup for ${designId}`).toBe(true);
      expect(existsSync(new URL(file!.replace(/\.png$/, ".prompt.txt"), designRoot)), `Missing prompt for ${designId}`).toBe(true);
    }
  });

  it("keeps supporting states and panels paired with their approved prompts", () => {
    for (const screen of catalog.screens.filter(screen => screen.status !== "superseded")) {
      expect(existsSync(new URL(screen.file, designRoot)), `Missing mockup for ${screen.id}`).toBe(true);
      expect(existsSync(new URL(screen.file.replace(/\.png$/, ".prompt.txt"), designRoot)), `Missing prompt for ${screen.id}`).toBe(true);
    }
  });

  it("uses the confirmed remote workspaces and removes the retired design", () => {
    const remote = labs.find(lab => lab.id === "remote-agent-lab")!;
    expect(remote.views.map(view => view.id)).toEqual(["openhands", "openclaw"]);
    expect(remote.views.every(view => view.designStatus === "approved")).toBe(true);
    expect(catalog.screens.find(screen => screen.id === "remote.openhands.run")).toBeUndefined();
    expect(existsSync(new URL("screens/remote-agent-lab/openhands/run.png", designRoot))).toBe(false);
    expect(catalog.screens.filter(screen => screen.id.startsWith("remote."))).toHaveLength(7);
  });

  it("resolves valid routes and rejects unknown modules", () => {
    expect(parseHash("#/atlas")).toEqual({ atlas: true });
    expect(parseHash("#/lab/agent-lab/codex")).toMatchObject({ lab: { id: "agent-lab" }, viewId: "codex" });
    expect(parseHash("#/lab/rsi-lab/not-a-view")).toMatchObject({ lab: { id: "rsi-lab" }, viewId: undefined });
    expect(parseHash("#/lab/unknown")).toEqual({});
    expect(parseHash("#/")).toEqual({});
  });
});
