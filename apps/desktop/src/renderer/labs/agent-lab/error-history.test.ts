import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "./agent-store";
import { TranscriptItem } from "./AgentWorkspace";

const entry: TranscriptEntry = { id: "error", runId: "session", kind: "error", at: "2026-09-26T18:40:37Z", text: "Kimi Code 已退出（SIGTERM）" };
const render = (value: TranscriptEntry): string => renderToStaticMarkup(createElement(TranscriptItem, {
  entry: value, runtimeId: "kimi-code", workspace: null, onApprove: () => {}, approvalBusy: false,
}));
describe("connection error history presentation", () => {
  it("keeps a fresh failure as an active alert", () => {
    expect(render(entry)).toContain('role="alert"');
    expect(render(entry)).not.toContain("历史错误");
  });
  it("collapses earlier failures after a reconnect without deleting their details or time", () => {
    const html = render({ ...entry, reconnectedAt: "2026-09-26T21:03:01Z" });
    expect(html).toContain('<details class="agent-error-history">');
    for (const text of ["历史错误", "后续已重新连接", "SIGTERM", entry.at, "2026-09-26T21:03:01Z"]) expect(html).toContain(text);
    expect(html).not.toContain('role="alert"');
  });
});
