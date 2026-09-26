import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeId, TranscriptEntry } from "./agent-store";
import { TranscriptItem } from "./AgentWorkspace";
import { SettingsPanel } from "../../shell/SettingsPanel";

function approval(runtimeId: AgentRuntimeId, title: string): string {
  const entry: TranscriptEntry = {
    id: "approval-test", kind: "approval", runId: "run", at: "2026-09-27T00:00:00Z",
    text: "pwd", approval: { requestId: "request", title, toolCallId: "tool",
      options: [{ optionId: "allow_once", name: "允许一次", kind: "allow" }] },
  };
  return renderToStaticMarkup(createElement(TranscriptItem, {
    entry, runtimeId, workspace: "/workspace", onApprove: () => {}, approvalBusy: false,
  }));
}

describe("Pi command permission notice", () => {
  it("keeps connection settings focused on provider configuration", () => {
    const markup = renderToStaticMarkup(createElement(SettingsPanel, {
      info: null, runtimeId: "pi", onClose: () => {}, onProviderSaved: () => {},
    }));
    expect(markup).toContain("填写支持 OpenAI Chat Completions 的 API 根地址、模型 ID 和 API Key。");
    expect(markup).not.toContain("执行命令前");
    expect(markup).not.toContain("目录外");
  });

  it("shows the boundary warning alongside the command without changing the approval options", () => {
    const markup = approval("pi", "命令执行授权");
    expect(markup).toContain("允许后，命令可能访问工作目录外。");
    expect(markup).toContain("pwd");
    expect(markup).toContain("允许一次");
  });

  it("does not show the command warning for file approvals or other harnesses", () => {
    expect(approval("pi", "文件修改授权")).not.toContain("工作目录外");
    for (const id of ["dsh", "codex", "kimi-code"] as const) {
      expect(approval(id, "命令执行授权")).not.toContain("工作目录外");
    }
  });
});
