import { describe, expect, it } from "vitest";
import { ClaudeSessionPermissions } from "./claude-permissions";
import type { SessionPermissionStore } from "./session-permissions";

describe("Claude native permission restoration", () => {
  const fixture = () => {
    const records = new Map<string, unknown>();
    const store: SessionPermissionStore = { get: key => records.get(key), set: (key, value) => { records.set(key, structuredClone(value)); } };
    return { store, records };
  };
  it("restores the explicitly approved native mode only in its original workspace", () => {
    const { store } = fixture(); const first = new ClaudeSessionPermissions(store);
    expect(first.load("/workspace").permissionMode).toBe("default");
    first.remember([{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
    expect(new ClaudeSessionPermissions(store).load("/workspace").permissionMode).toBe("acceptEdits");
    expect(new ClaudeSessionPermissions(store).load("/other").permissionMode).toBe("default");
    expect(new ClaudeSessionPermissions().load("/workspace").permissionMode).toBe("default");
  });
  it("preserves native rule patterns, behaviors and directory additions/removals", () => {
    const { store } = fixture(); const grants = new ClaudeSessionPermissions(store); grants.load("/workspace");
    grants.remember([
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test *" }], behavior: "allow", destination: "session" },
      { type: "addRules", rules: [{ toolName: "Edit", ruleContent: "./secrets/**" }], behavior: "deny", destination: "session" },
      { type: "addRules", rules: [{ toolName: "WebFetch" }], behavior: "ask", destination: "session" },
      { type: "addDirectories", directories: ["/approved", "/removed"], destination: "session" },
      { type: "removeDirectories", directories: ["/removed"], destination: "session" },
    ]);
    expect(new ClaudeSessionPermissions(store).load("/workspace")).toEqual({ permissionMode: "default", additionalDirectories: ["/approved"],
      permissions: { allow: ["Bash(npm test *)"], deny: ["Edit(./secrets/**)"], ask: ["WebFetch"] } });
    grants.remember([{ type: "removeRules", rules: [{ toolName: "Bash", ruleContent: "npm test *" }], behavior: "allow", destination: "session" }]);
    expect(new ClaudeSessionPermissions(store).load("/workspace").permissions.allow).toBeUndefined();
  });
  it("does not introduce bypass mode, global grants or unsupported policies", () => {
    const { store, records } = fixture(); const grants = new ClaudeSessionPermissions(store); grants.load("/workspace");
    expect(grants.canRemember([{ type: "setMode", mode: "bypassPermissions", destination: "session" }])).toBe(false);
    expect(() => grants.remember([{ type: "setMode", mode: "bypassPermissions", destination: "session" }])).toThrow(/授权范围/);
    records.set("claude-native-permissions-v1", { workspace: "/workspace", updates: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] });
    expect(grants.load("/workspace").permissionMode).toBe("default");
  });
  it("does not release a grant when its durable write fails", () => {
    const grants = new ClaudeSessionPermissions({ get: () => undefined, set: () => { throw new Error("storage failure"); } }); grants.load("/workspace");
    expect(() => grants.remember([{ type: "setMode", mode: "acceptEdits", destination: "session" }])).toThrow("storage failure");
  });
});
