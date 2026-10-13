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
  it("exposes exactly four implemented labs and preserves their runtime and experiment entries", () => {
    expect(labs.map(lab => lab.id)).toEqual(["agent-lab", "remote-agent-lab", "local-model-lab", "jev-lab"]);
    expect(labs.every(lab => typeof lab.Page === "function")).toBe(true);
    expect(labs[0].views.map(view => view.id)).toEqual(["dsh", "codex", "pi", "kimi-code", "qwen-code", "claude-code"]);
    expect(labs[1].views.map(view => view.id)).toEqual(["openhands", "openclaw"]);
    expect(labs[2].views.map(view => view.id)).toEqual(["playground", "compare"]);
    expect(labs[3].views.map(view => view.id)).toEqual(["agent-review", "customer-action", "invoice-routing", "xiangqi"]);
  });

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

  it("uses the confirmed remote workspaces without retired takeover or execution-terminal designs", () => {
    const remote = labs.find(lab => lab.id === "remote-agent-lab")!;
    expect(remote.views.map(view => view.id)).toEqual(["openhands", "openclaw"]);
    expect(remote.views.every(view => view.designStatus === "approved")).toBe(true);
    expect(catalog.screens.find(screen => screen.id === "remote.openhands.run")).toBeUndefined();
    expect(existsSync(new URL("screens/remote-agent-lab/openhands/run.png", designRoot))).toBe(false);
    expect(catalog.screens.filter(screen => screen.id.startsWith("remote.")).map(screen => screen.id)).toEqual([
      "remote.index", "remote.openhands.workspace", "remote.openclaw.workspace", "remote.service-panel", "remote.interaction-states",
    ]);
    for (const retired of ["takeover", "terminal"]) {
      expect(existsSync(new URL(`screens/remote-agent-lab/openclaw/${retired}.png`, designRoot))).toBe(false);
      expect(existsSync(new URL(`screens/remote-agent-lab/openclaw/${retired}.prompt.txt`, designRoot))).toBe(false);
    }
  });

  it("resolves valid routes and rejects unknown modules", () => {
    expect(parseHash("#/lab/agent-lab/codex")).toMatchObject({ lab: { id: "agent-lab" }, viewId: "codex" });
    expect(parseHash("#/lab/remote-agent-lab/openclaw")).toMatchObject({ lab: { id: "remote-agent-lab" }, viewId: "openclaw" });
    expect(parseHash("#/lab/local-model-lab/not-a-view")).toMatchObject({ lab: { id: "local-model-lab" }, viewId: undefined });
    expect(parseHash("#/lab/unknown")).toEqual({});
    expect(parseHash("#/")).toEqual({});
  });

  it.each(["#/atlas", "#/lab/founder-studio", "#/lab/harness-forge", "#/lab/rsi-lab"])("does not resolve removed route %s", hash => {
    expect(parseHash(hash)).toEqual({});
  });
});
