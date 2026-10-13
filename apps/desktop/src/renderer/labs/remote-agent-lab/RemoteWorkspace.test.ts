import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

describe("remote workspace explanations", () => {
  it("keeps both workspaces free of permanent storage notes and empty hint rows", async () => {
    vi.stubGlobal("window", { agentLab: {} });
    vi.stubGlobal("self", globalThis);
    try {
      const { RemoteWorkspace } = await import("./RemoteWorkspace");
      for (const engine of ["openclaw", "openhands"] as const) {
        const html = renderToStaticMarkup(createElement(RemoteWorkspace, { engine, available: true, revision: 0 }));
        expect(html).toContain("新建远端任务");
        expect(html).toContain("上传文件");
        expect(html).not.toContain("文件与任务保存在服务端");
        expect(html).not.toContain("关闭应用");
        expect(html).not.toContain("remote-composer__hint");
        expect(html).not.toContain("<footer");
      }
    } finally { vi.unstubAllGlobals(); }
  });
});
