import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRuntimeId } from "../../../../packages/contracts/src/index";

export interface AgentViewPreference {
  selectedSessionId: string | null;
  lastWorkspace: string | null;
}

type AppConfig = { version: 1; agentLab: Partial<Record<AgentRuntimeId, AgentViewPreference>> };

/** Small, human-readable application preferences. Conversation data lives in SQLite. */
export class AppConfigStore {
  private data: AppConfig = { version: 1, agentLab: {} };
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path(), "utf8"));
      if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) throw new Error("应用配置文件版本无效");
      const agentLab = (parsed as { agentLab?: unknown }).agentLab;
      if (!agentLab || typeof agentLab !== "object" || Array.isArray(agentLab)) throw new Error("应用配置文件格式无效");
      for (const runtimeId of ["dsh", "codex", "pi", "kimi-code"] as const) {
        const value = (agentLab as Record<string, unknown>)[runtimeId];
        if (!value || typeof value !== "object") continue;
        const preference = value as Partial<AgentViewPreference>;
        this.data.agentLab[runtimeId] = {
          selectedSessionId: typeof preference.selectedSessionId === "string" ? preference.selectedSessionId : null,
          lastWorkspace: typeof preference.lastWorkspace === "string" ? preference.lastWorkspace : null,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.write();
    }
  }

  get(runtimeId: AgentRuntimeId): AgentViewPreference {
    return { ...(this.data.agentLab[runtimeId] ?? { selectedSessionId: null, lastWorkspace: null }) };
  }

  async migrateLegacyWorkspaces(workspaces: Partial<Record<AgentRuntimeId, string>>): Promise<void> {
    if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) throw new Error("旧工作目录格式无效");
    let changed = false;
    for (const runtimeId of ["dsh", "codex", "pi", "kimi-code"] as const) {
      const workspace = workspaces[runtimeId];
      if (workspace === undefined) continue;
      if (typeof workspace !== "string" || !workspace.trim() || workspace.length > 4096 || /\0/u.test(workspace)) throw new Error("旧工作目录格式无效");
      const current = this.data.agentLab[runtimeId];
      if (current?.lastWorkspace) continue;
      this.data.agentLab[runtimeId] = { selectedSessionId: current?.selectedSessionId ?? null, lastWorkspace: workspace };
      changed = true;
    }
    if (changed) await this.write();
  }

  async select(runtimeId: AgentRuntimeId, sessionId: string, workspace: string): Promise<void> {
    const current = this.data.agentLab[runtimeId];
    if (current?.selectedSessionId === sessionId && current.lastWorkspace === workspace) return;
    this.data.agentLab[runtimeId] = { selectedSessionId: sessionId, lastWorkspace: workspace };
    await this.write();
  }

  private path(): string { return join(this.root, "app-config.json"); }

  private write(): Promise<void> {
    const contents = JSON.stringify(this.data, null, 2);
    const current = this.pendingWrite.then(async () => {
      const temporary = join(this.root, `app-config-${randomUUID()}.tmp`);
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, this.path());
    });
    this.pendingWrite = current.catch(() => {});
    return current;
  }
}
