/** App-owned, per-session storage; adapters retain their own permission semantics. */
export interface SessionPermissionStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}
