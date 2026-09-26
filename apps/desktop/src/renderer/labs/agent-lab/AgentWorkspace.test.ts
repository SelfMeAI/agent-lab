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
  it("keeps Qwen settings consistent and localizes native permission scope without changing option IDs", () => {
    const markup = renderToStaticMarkup(createElement(SettingsPanel, {
      info: null, runtimeId: "qwen-code", onClose: () => {}, onProviderSaved: () => {},
    }));
    expect(markup).toContain("Qwen Code 模型连接");
    expect(markup).toContain("获取模型");
    expect(markup).toContain("OpenAI Chat Completions");
    const entry: TranscriptEntry = {
      id: "qwen-approval", kind: "approval", runId: "run", at: "2026-09-27T00:00:00Z", text: "Execute: pwd",
      approval: { requestId: "request", title: "Execute: pwd", options: [
        { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
        { optionId: "proceed_always_project", name: "Always Allow in project: pwd", kind: "allow_always" },
        { optionId: "proceed_always_user", name: "Always Allow for user: pwd", kind: "allow_always" },
        { optionId: "cancel", name: "Reject", kind: "reject_once" },
      ] },
    };
    const card = renderToStaticMarkup(createElement(TranscriptItem, { entry, runtimeId: "qwen-code", workspace: "/workspace", onApprove: () => {}, approvalBusy: false }));
    expect(card).toContain("请求执行：pwd");
    expect(card).toContain("允许一次");
    expect(card).toContain("本项目始终允许: pwd");
    expect(card).toContain("此用户始终允许: pwd");
    expect(card).toContain("拒绝");
  });
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
    for (const id of ["dsh", "codex", "kimi-code", "qwen-code"] as const) {
      expect(approval(id, "命令执行授权")).not.toContain("工作目录外");
    }
  });
});
