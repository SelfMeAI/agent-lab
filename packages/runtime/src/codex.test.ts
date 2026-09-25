import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../contracts/src/index";
import { CodexAdapter } from "./codex";

describe("Codex diff notifications", () => {
  it("offers session-scoped approval only when Codex supports it", () => {
    const adapter = new CodexAdapter({ executable: "unused", homeDirectory: "unused", provider: async () => ({ baseUrl: "", model: "", apiKey: "" }) });
    const events: RunEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    const server = adapter as unknown as { handleServerRequest(message: Record<string, unknown>, method: string): void };
    server.handleServerRequest({ id: 4, params: { itemId: "edit-1", reason: "编辑文件" } }, "item/fileChange/requestApproval");
    expect(events.find((event) => event.kind === "approval")?.approval?.options.map((option) => option.optionId)).toEqual(["accept", "acceptForSession", "decline"]);
  });

  it("publishes an updatable turn-level file artifact and completes it with the turn", () => {
    const adapter = new CodexAdapter({ executable: "unused", homeDirectory: "unused", provider: async () => ({ baseUrl: "", model: "", apiKey: "" }) });
    const events: RunEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    const notify = adapter as unknown as { handleNotification(method: string, params: Record<string, unknown>): void };
    notify.handleNotification("turn/started", { turn: { id: "turn-1" } });
    notify.handleNotification("turn/diff/updated", { turnId: "turn-1", diff: "diff --git a/a.txt b/a.txt\n+new\n" });
    notify.handleNotification("turn/diff/updated", { turnId: "turn-1", diff: "diff --git a/a.txt b/a.txt\n+newer\n" });
    notify.handleNotification("turn/completed", { turn: { status: "completed" } });
    const diffEvents = events.filter((event) => event.toolCallId === "turn-diff:turn-1");
    expect(diffEvents.map((event) => event.toolStatus)).toEqual(["running", "running", "finished"]);
    expect(diffEvents[1].raw).toEqual({ type: "turnDiff", diff: "diff --git a/a.txt b/a.txt\n+newer\n" });
  });

  it("treats a retrying connection as transient running status, not a failed task", () => {
    const adapter = new CodexAdapter({ executable: "unused", homeDirectory: "unused", provider: async () => ({ baseUrl: "", model: "", apiKey: "" }) });
    const events: RunEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    const notify = adapter as unknown as { handleNotification(method: string, params: Record<string, unknown>): void };
    notify.handleNotification("error", { error: { message: "Reconnecting... 1/5" }, willRetry: true });
    expect(events.at(-1)).toMatchObject({ kind: "status", phase: "running", text: "Codex 正在重连 · Reconnecting... 1/5" });
  });
});
