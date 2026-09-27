import { describe, expect, it } from "vitest";
import { ExactNativePermissions } from "./exact-native-permissions";
import type { SessionPermissionStore } from "./session-permissions";

describe("exact native approval boundaries", () => {
  it("restores only the exact native scope across request/turn IDs and object key order", () => {
    const records = new Map<string, unknown>();
    const store: SessionPermissionStore = { get: key => records.get(key), set: (key, value) => { records.set(key, structuredClone(value)); } };
    const first = new ExactNativePermissions("native", store); first.load("/workspace");
    const params = { command: "echo private-test-key", cwd: "/workspace", threadId: "one", turnId: "first", itemId: "tool-a", startedAtMs: 1, approvalId: "first-dialog", additionalPermissions: { network: { enabled: false } } };
    const hash = first.fingerprint("command", params); first.remember(hash);
    expect(JSON.stringify([...records.values()])).not.toContain("private-test-key");
    const resumed = new ExactNativePermissions("native", store); resumed.load("/workspace");
    expect(resumed.has(resumed.fingerprint("command", { ...params, threadId: "two", turnId: "next", itemId: "tool-b", startedAtMs: 2, approvalId: "next-dialog" }))).toBe(true);
    for (const changed of [{ ...params, command: "echo different" }, { ...params, cwd: "/outside" }, { ...params, additionalPermissions: { network: { enabled: true } } }]) {
      expect(resumed.has(resumed.fingerprint("command", changed))).toBe(false);
    }
    expect(resumed.has(resumed.fingerprint("file", params))).toBe(false);
    resumed.load("/other"); expect(resumed.has(hash)).toBe(false);
    const sibling = new ExactNativePermissions("different", store); sibling.load("/workspace"); expect(sibling.has(hash)).toBe(false);
  });
  it("does not install an authorization if SQLite rejects the write", () => {
    const native = new ExactNativePermissions("native", { get: () => undefined, set: () => { throw new Error("write failed"); } }); native.load("/workspace");
    const hash = native.fingerprint("command", { command: "echo ok" });
    expect(() => native.remember(hash)).toThrow("write failed"); expect(native.has(hash)).toBe(false);
  });
});
