import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LabPage } from "./LabPage";
import { labs } from "./registry";

describe("lab entry layout boundary", () => {
  it("uses the same unpadded outer page for all three module indexes", () => {
    for (const [id, count] of [["agent-lab", 6], ["remote-agent-lab", 2], ["jev-lab", 4]] as const) {
      const lab = labs.find(row => row.id === id)!;
      const html = renderToStaticMarkup(createElement(LabPage, { lab }));
      expect(html).toContain('<main class="lab-index-page">');
      expect(html).toContain("lab-index-layout");
      expect(html).toContain("lab-index-heading");
      expect(html.match(/<h1>/g)).toHaveLength(1);
      expect(html.match(/<button/g)).toHaveLength(count + (id === "remote-agent-lab" ? 1 : 0));
    }
  });
  it("does not apply entry-page sizing to any existing workspace or the local model workbench", () => {
    for (const original of labs) {
      const lab = { ...original, Page: () => createElement("div", null, "workspace fixture") };
      for (const viewId of [undefined, ...lab.views.map(view => view.id)]) {
        if (!viewId && lab.id !== "local-model-lab") continue;
        const html = renderToStaticMarkup(createElement(LabPage, { lab, viewId }));
        expect(html).toContain("workspace fixture");
        expect(html).not.toContain("lab-index-page");
      }
    }
  });
});
