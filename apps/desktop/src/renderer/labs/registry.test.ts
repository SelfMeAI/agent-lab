import { describe, expect, it } from "vitest";
import { parseHash } from "../app/navigation";
import { labs } from "./registry";

describe("implemented lab modules and routes", () => {
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
    for (const lab of labs) {
      expect(new Set(lab.views.map((view) => view.id)).size).toBe(lab.views.length);
    }
  });

  it.each(labs)("resolves every implemented view in $label without a design catalog", lab => {
    for (const view of lab.views) expect(parseHash(`#/lab/${lab.id}/${view.id}`)).toMatchObject({ lab: { id: lab.id }, viewId: view.id });
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
