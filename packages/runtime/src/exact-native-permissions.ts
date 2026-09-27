import { createHash } from "node:crypto";
import type { SessionPermissionStore } from "./session-permissions";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Conservative replay of an identical native request, never a guessed prefix/tool-wide grant. */
export class ExactNativePermissions {
  private workspace = "";
  private approved = new Set<string>();
  constructor(private readonly key: string, private readonly store?: SessionPermissionStore) {}
  load(workspace: string): void {
    const saved = this.store?.get(this.key) as { workspace?: unknown; approved?: unknown } | undefined;
    if (workspace !== this.workspace || this.store) this.approved.clear();
    this.workspace = workspace;
    if (saved?.workspace === workspace && Array.isArray(saved.approved)) {
      for (const hash of saved.approved) if (typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)) this.approved.add(hash);
    }
  }
  fingerprint(method: string, params: Record<string, unknown>, targets?: unknown): string {
    const scope = Object.fromEntries(Object.entries(params).filter(([key]) => !["threadId", "turnId", "itemId", "approvalId", "startedAtMs"].includes(key)));
    // Hash commands/paths so credentials embedded in a command are not copied
    // into a second storage surface. Include all native risk/permission fields.
    return createHash("sha256").update(JSON.stringify(canonical({ method, workspace: this.workspace, scope, targets }))).digest("hex");
  }
  has(hash: string): boolean { return this.approved.has(hash); }
  remember(hash: string): void {
    const approved = [...new Set([...this.approved, hash])];
    this.store?.set(this.key, { workspace: this.workspace, approved });
    this.approved.add(hash);
  }
}
