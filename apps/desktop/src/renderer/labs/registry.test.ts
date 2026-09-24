import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseHash } from "../app/navigation";
import { labs } from "./registry";

interface Catalog {
  screens: Array<{ id: string; file: string }>;
}

const designRoot = new URL("../../../../../design/", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("catalog.json", designRoot), "utf8")) as Catalog;

describe("lab modules and approved designs", () => {
  it("keeps every lab and view identifier unique", () => {
    expect(new Set(labs.map((lab) => lab.id)).size).toBe(labs.length);
    for (const lab of labs) {
      expect(new Set(lab.views.map((view) => view.id)).size).toBe(lab.views.length);
    }
  });

  it("maps each view to an existing approved mockup", () => {
    const files = new Map(catalog.screens.map((screen) => [screen.id, screen.file]));
    const designIds = new Set(labs.flatMap((lab) => lab.views.map((view) => view.designId)));
    designIds.add("home.index");
    designIds.add("agent.index");
    expect(designIds.size).toBe(catalog.screens.length);
    for (const designId of designIds) {
      const file = files.get(designId);
      expect(file, `Missing catalog entry for ${designId}`).toBeDefined();
      expect(existsSync(new URL(file!, designRoot)), `Missing mockup for ${designId}`).toBe(true);
      expect(existsSync(new URL(file!.replace(/\.png$/, ".prompt.txt"), designRoot)), `Missing prompt for ${designId}`).toBe(true);
    }
  });

  it("resolves valid routes and rejects unknown modules", () => {
    expect(parseHash("#/lab/agent-lab/codex")).toMatchObject({ lab: { id: "agent-lab" }, viewId: "codex" });
    expect(parseHash("#/lab/rsi-lab/not-a-view")).toMatchObject({ lab: { id: "rsi-lab" }, viewId: undefined });
    expect(parseHash("#/lab/unknown")).toEqual({});
    expect(parseHash("#/")).toEqual({});
  });
});
