import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../contracts/src/index";
import { PiAdapter } from "./pi";
import type { SessionPermissionStore } from "./session-permissions";

function fixture(store?: SessionPermissionStore) {
  const adapter = new PiAdapter({ homeDirectory: "unused", permissions: store, provider: async () => ({ apiKey: "", baseUrl: "", model: "" }) });
  const events: RunEvent[] = []; adapter.onEvent(event => events.push(event));
  const native = adapter as unknown as { workspace: string; allowedForSession: Set<string>; approvals: Map<string, unknown>; requireApproval(id: string, tool: string, detail: string, signal?: AbortSignal): Promise<void> };
  native.workspace = "/workspace"; return { adapter, native, events };
}

describe("Pi session permission boundaries", () => {
  it("persists only the selected tool class", async () => {
    const records = new Map<string, unknown>();
    const { adapter, native, events } = fixture({ get: key => records.get(key), set: (key, value) => { records.set(key, value); } });
    const write = native.requireApproval("write", "write", "a.txt");
    const request = events.at(-1)!.approval!; await adapter.respondApproval(request.requestId, "allow_session"); await write;
    expect(records.get("pi-tool-permissions-v1")).toEqual({ workspace: "/workspace", tools: ["write"] });
    await native.requireApproval("write-again", "write", "b.txt");
    const edit = native.requireApproval("edit", "edit", "a.txt");
    expect(native.approvals.size).toBe(1); await adapter.respondApproval(events.at(-1)!.approval!.requestId, "allow_once"); await edit;
    expect(native.allowedForSession).toEqual(new Set(["write"]));
  });
  it("keeps the action waiting if persistence fails, so the user can still choose once", async () => {
    const { adapter, native, events } = fixture({ get: () => undefined, set: () => { throw new Error("SQLite write failed"); } });
    const waiting = native.requireApproval("write", "write", "a.txt"), request = events.at(-1)!.approval!;
    await expect(adapter.respondApproval(request.requestId, "allow_session")).rejects.toThrow("SQLite write failed");
    expect(native.approvals.size).toBe(1); expect(native.allowedForSession.size).toBe(0);
    await adapter.respondApproval(request.requestId, "allow_once"); await waiting;
  });
  it("does not remember a cancelled or denied operation", async () => {
    const { adapter, native, events } = fixture(); const controller = new AbortController();
    const pending = native.requireApproval("write", "write", "a.txt", controller.signal);
    const rejection = expect(pending).rejects.toThrow(/取消/); controller.abort(); await rejection;
    await expect(adapter.respondApproval(events.find(event => event.approval)!.approval!.requestId, "allow_session")).rejects.toThrow(/失效/);
    expect(native.allowedForSession.size).toBe(0);
  });
});
