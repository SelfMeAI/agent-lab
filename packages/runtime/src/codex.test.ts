import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../contracts/src/index";
import { CodexAdapter } from "./codex";

describe("Codex diff notifications", () => {
  it("uses only offered native decisions and forwards the exact persistent amendment", async () => {
    const adapter = new CodexAdapter({ executable: "unused", homeDirectory: "unused", provider: async () => ({ baseUrl: "", model: "", apiKey: "" }) });
    const events: RunEvent[] = [], replies: unknown[] = []; adapter.onEvent(event => events.push(event));
    const server = adapter as unknown as { handleServerRequest(message: Record<string, unknown>, method: string): void; write(value: unknown): void };
    server.write = reply => replies.push(reply);
    const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["/bin/zsh", "-lc", "npm test"] } };
    server.handleServerRequest({ id: 9, params: { command: "npm test", cwd: "/workspace", availableDecisions: ["accept", decision, "cancel"] } }, "item/commandExecution/requestApproval");
    expect(events.find(event => event.kind === "approval")!.approval!.options.map(option => option.optionId)).toEqual(["accept", "acceptWithExecpolicyAmendment", "cancel"]);
    await expect(adapter.respondApproval(9, "acceptForSession")).rejects.toThrow(/无效/);
    await adapter.respondApproval(9, "acceptWithExecpolicyAmendment");
    expect(replies).toEqual([{ id: 9, result: { decision } }]);
  });
  it("does not auto-approve a changed scope, an opaque request or a native once-only prompt", async () => {
    const rows = new Map<string, unknown>();
    const options = { executable: "unused", homeDirectory: "unused", permissions: { get: (key: string) => rows.get(key), set: (key: string, value: unknown) => { rows.set(key, structuredClone(value)); } }, provider: async () => ({ baseUrl: "", model: "", apiKey: "" }) };
    const fixture = () => {
      const adapter = new CodexAdapter(options), events: RunEvent[] = [], replies: unknown[] = []; adapter.onEvent(event => events.push(event));
      const native = adapter as unknown as { permissions: { load(workspace: string): void }; handleServerRequest(message: Record<string, unknown>, method: string): void; write(value: unknown): void };
      native.permissions.load("/workspace"); native.write = reply => replies.push(reply);
      return { adapter, events, replies, native };
    };
    const params = { command: "npm test", cwd: "/workspace", itemId: "one", turnId: "old", startedAtMs: 1, additionalPermissions: { network: { enabled: false } }, availableDecisions: ["accept", "acceptForSession", "decline"] };
    const first = fixture(); first.native.handleServerRequest({ id: 1, params }, "item/commandExecution/requestApproval"); await first.adapter.respondApproval(1, "acceptForSession");
    const next = fixture(); next.native.handleServerRequest({ id: 2, params: { ...params, itemId: "two", turnId: "new", startedAtMs: 2 } }, "item/commandExecution/requestApproval");
    expect(next.events.some(event => event.kind === "approval")).toBe(false); expect(next.replies).toEqual([{ id: 2, result: { decision: "acceptForSession" } }]);
    for (const request of [{ ...params, command: "npm install" }, { ...params, additionalPermissions: { network: { enabled: true } } }, { ...params, availableDecisions: ["accept", "decline"] }, { reason: "opaque action" }]) {
      const check = fixture(); check.native.handleServerRequest({ id: 3, params: request }, "item/commandExecution/requestApproval");
      expect(check.events.some(event => event.kind === "approval")).toBe(true); expect(check.replies).toEqual([]);
    }
  });
  it("does not overwrite a completed cancellation with the later interrupt RPC reply", async () => {
    const adapter = new CodexAdapter({ executable: "unused", homeDirectory: "unused", provider: async () => ({ baseUrl: "", model: "", apiKey: "" }) });
    const internals = adapter as unknown as {
      phase: string; threadId: string; turnId: string | null;
      request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
      handleNotification(method: string, params: Record<string, unknown>): void;
    };
    internals.phase = "running"; internals.threadId = "thread"; internals.turnId = "turn";
    const events: RunEvent[] = []; adapter.onEvent(event => events.push(event));
    internals.request = async (method, params) => {
      expect(method).toBe("turn/interrupt"); expect(params).toEqual({ threadId: "thread", turnId: "turn" });
      expect(internals.phase).toBe("cancelling");
      internals.handleNotification("turn/completed", { turn: { id: "turn", status: "interrupted" } });
      return {};
    };
    await adapter.cancel();
    expect(events.map(event => event.phase)).toEqual(["cancelling", "ready"]);
    expect(internals.phase).toBe("ready"); expect(internals.turnId).toBeNull();
  });

  it("does not leave an active task stuck in cancelling when the interrupt request fails", async () => {
    const adapter = new CodexAdapter({ executable: "unused", homeDirectory: "unused", provider: async () => ({ baseUrl: "", model: "", apiKey: "" }) });
    const internals = adapter as unknown as { phase: string; threadId: string; turnId: string; request(): Promise<Record<string, unknown>> };
    internals.phase = "running"; internals.threadId = "thread"; internals.turnId = "turn";
    internals.request = async () => { throw new Error("interrupt timeout"); };
    await expect(adapter.cancel()).rejects.toThrow(/timeout/);
    expect(internals.phase).toBe("running");
  });

  it("does not consume duplicate supplements twice for started/completed of the same native item", async () => {
    const adapter = new CodexAdapter({ executable: "unused", homeDirectory: "unused", provider: async () => ({ baseUrl: "", model: "", apiKey: "" }) });
    const internals = adapter as unknown as {
      phase: string; threadId: string; turnId: string;
      request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
      handleNotification(method: string, params: Record<string, unknown>): void;
    };
    internals.phase = "running"; internals.threadId = "thread"; internals.turnId = "turn";
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    internals.request = async (method, params) => { requests.push({ method, params }); return { turnId: "turn" }; };
    const events: RunEvent[] = [];
    adapter.onEvent(e => events.push(e));
    await adapter.steer("same", "first");
    await adapter.steer("same", "second");
    const item = { type: "userMessage", id: "user-1", content: [{ type: "text", text: "same" }] };
    internals.handleNotification("item/started", { item });
    internals.handleNotification("item/completed", { item });
    expect(events.filter(e => e.deliveryState === "incorporated").map(e => e.messageId)).toEqual(["first"]);
    internals.handleNotification("item/started", { item: { ...item, id: "user-2" } });
    expect(events.filter(e => e.deliveryState === "incorporated").map(e => e.messageId)).toEqual(["first", "second"]);
    expect(requests.map(r => r.method)).toEqual(["turn/steer", "turn/steer"]);
    expect(requests[0].params).toMatchObject({ threadId: "thread", expectedTurnId: "turn" });
  });

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
