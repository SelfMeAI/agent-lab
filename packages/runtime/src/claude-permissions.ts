import type { Options, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { SessionPermissionStore } from "./session-permissions";

const key = "claude-native-permissions-v1";
type State = { workspace: string; updates: PermissionUpdate[] };
const modes = new Set(["default", "acceptEdits", "plan", "dontAsk"]);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

function valid(value: unknown): value is PermissionUpdate {
  if (!value || typeof value !== "object") return false;
  const update = value as Record<string, unknown>;
  if (update.destination !== "session") return false;
  if (update.type === "setMode") return typeof update.mode === "string" && modes.has(update.mode);
  if (update.type === "addDirectories" || update.type === "removeDirectories") return strings(update.directories);
  return ["addRules", "replaceRules", "removeRules"].includes(String(update.type))
    && ["allow", "deny", "ask"].includes(String(update.behavior)) && Array.isArray(update.rules)
    && update.rules.every(rule => rule && typeof rule === "object" && typeof rule.toolName === "string"
      && (rule.ruleContent === undefined || typeof rule.ruleContent === "string"));
}

export class ClaudeSessionPermissions {
  private state: State = { workspace: "", updates: [] };
  constructor(private readonly store?: SessionPermissionStore) {}

  load(workspace: string): Pick<Options, "permissionMode" | "additionalDirectories"> & { permissions: Record<string, unknown> } {
    const saved = (this.store?.get(key) ?? this.state) as Partial<State> | null;
    this.state = saved?.workspace === workspace && Array.isArray(saved.updates) && saved.updates.every(valid)
      ? { workspace, updates: saved.updates } : { workspace, updates: [] };
    const rules = { allow: new Set<string>(), deny: new Set<string>(), ask: new Set<string>() };
    const directories = new Set<string>();
    let permissionMode: Options["permissionMode"] = "default";
    for (const update of this.state.updates) {
      if (update.type === "setMode") permissionMode = update.mode;
      else if (update.type === "addDirectories" || update.type === "removeDirectories") {
        for (const path of update.directories) {
          if (update.type === "addDirectories") directories.add(path); else directories.delete(path);
        }
      } else {
        const bucket = rules[update.behavior];
        if (update.type === "replaceRules") bucket.clear();
        for (const rule of update.rules) {
          const value = rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`;
          if (update.type === "removeRules") bucket.delete(value); else bucket.add(value);
        }
      }
    }
    // Restore through native configuration, not by automatically answering
    // callbacks: native deny/ask rules and protected paths must still win.
    return { permissionMode, additionalDirectories: [...directories],
      permissions: Object.fromEntries(Object.entries(rules).filter(([, values]) => values.size).map(([kind, values]) => [kind, [...values]])) };
  }

  canRemember(updates: PermissionUpdate[]): boolean {
    return updates.length > 0 && updates.every(update => valid({ ...update, destination: "session" }));
  }

  remember(updates: PermissionUpdate[]): void {
    if (!this.canRemember(updates)) throw new Error("此授权范围不支持会话恢复，请选择允许一次");
    const next = { workspace: this.state.workspace,
      updates: [...this.state.updates, ...updates.map(update => ({ ...update, destination: "session" as const }))] };
    this.store?.set(key, next); // Persist before releasing the protected action.
    this.state = next;
  }
}
