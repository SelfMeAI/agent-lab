import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Snapshot = string | null | undefined;

export interface TextFileDiff {
  type: "diff";
  path: string;
  oldText?: string;
  newText: string;
}

interface PendingEdit {
  path: string;
  before: Snapshot;
}

const MAX_DIFF_BYTES = 512 * 1024;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class FileChangeTracker {
  private readonly observed = new Map<string, Snapshot>();
  private readonly pending = new Map<string, PendingEdit>();
  private readonly workspace: string;

  constructor(workspace: string) { this.workspace = realpathSync(workspace); }

  start(callId: string, title: string | undefined, rawInput: unknown): void {
    const input = object(rawInput);
    const rawPath = typeof input.file_path === "string" ? input.file_path : undefined;
    if (!rawPath || !title || !["read", "edit", "write"].includes(title)) return;
    const requested = resolve(this.workspace, rawPath);
    let path: string;
    try { path = realpathSync(requested); }
    catch {
      try { path = join(realpathSync(dirname(requested)), basename(requested)); }
      catch { return; }
    }
    if (!this.withinWorkspace(path)) return;
    const current = this.readText(path);
    if (title === "read") {
      this.observed.set(path, current);
    } else {
      this.pending.set(callId, { path, before: current });
    }
  }

  finish(callId: string, succeeded: boolean): TextFileDiff | undefined {
    const pending = this.pending.get(callId);
    this.pending.delete(callId);
    if (!pending || !succeeded) return undefined;
    const after = this.readText(pending.path);
    let before = pending.before;
    if (before === after && this.observed.has(pending.path)) before = this.observed.get(pending.path);
    this.observed.set(pending.path, after);
    if (before === undefined || after === undefined || after === null || before === after) return undefined;
    return { type: "diff", path: pending.path, ...(before === null ? {} : { oldText: before }), newText: after };
  }

  clear(): void {
    this.observed.clear();
    this.pending.clear();
  }

  private withinWorkspace(path: string): boolean {
    const offset = relative(this.workspace, path);
    return offset !== "" && offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
  }

  private readText(path: string): Snapshot {
    try {
      const actual = realpathSync(path);
      if (!this.withinWorkspace(actual)) return undefined;
      const info = statSync(actual);
      if (!info.isFile() || info.size > MAX_DIFF_BYTES) return undefined;
      return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(actual));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      try {
        return this.withinWorkspace(realpathSync(dirname(path))) || dirname(path) === this.workspace ? null : undefined;
      } catch {
        return undefined;
      }
    }
  }
}
