import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HomePage } from "./HomePage";

describe("four-lab home", () => {
  it("renders one entry and Chinese subtitle for each retained lab", () => {
    const html = renderToStaticMarkup(createElement(HomePage));
    expect(html.match(/data-lab-id=/g)).toHaveLength(4);
    for (const [id, subtitle] of [
      ["agent-lab", "本地 Harness 实验"],
      ["remote-agent-lab", "远程 Agent 实验"],
      ["local-model-lab", "本地模型实验"],
      ["jev-lab", "决策模型实验"],
    ]) {
      expect(html).toContain(`data-lab-id="${id}"`);
      expect(html).toContain(subtitle);
    }
    expect(html).not.toContain("OVERVIEWS");
    expect(html).not.toContain("home-overview");
  });
});
