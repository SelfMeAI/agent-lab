import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LabIndexHeader } from "./LabIndexHeader";

describe("shared lab entry heading", () => {
  it("keeps the home title clean without a redundant icon or subtitle", () => {
    const html = renderToStaticMarkup(createElement(LabIndexHeader, { title: "LAB INDEX" }));
    expect(html).toContain("<h1>LAB INDEX</h1>");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<p>");
    expect(html).not.toContain("lab-index-heading__actions");
  });
  it("aligns module identity, Chinese guidance and real page actions", () => {
    const html = renderToStaticMarkup(createElement(LabIndexHeader, {
      title: "REMOTE AGENT LAB", subtitle: "远端智能体实验室", labId: "remote-agent-lab",
      actions: createElement("button", { type: "button" }, "服务管理"),
    }));
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain("lab-index-heading__icon");
    expect(html).toContain("<p>远端智能体实验室</p>");
    expect(html).toContain("lab-index-heading__actions");
    expect(html).toContain("服务管理");
  });
});
