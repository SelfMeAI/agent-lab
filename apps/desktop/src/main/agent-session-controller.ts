import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AgentRuntimeId, AgentSessionCatalog, AgentSessionEvent, AgentSessionSummary, RunEvent, RuntimePhase } from "../../../../packages/contracts/src/index";
import type { HarnessAdapter } from "../../../../packages/runtime/src/index";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

type LiveSession = { adapter: HarnessAdapter; unsubscribe: () => void };
type AdapterFactory = (runtimeId: AgentRuntimeId, sessionId: string) => HarnessAdapter;

const busyPhases = new Set<RuntimePhase>(["starting", "running", "approval", "cancelling"]);

/** Owns app sessions independently of each harness's native session identity. */
export class AgentSessionController {
  private readonly live = new Map<string, LiveSession>();
  private readonly operations = new Map<AgentRuntimeId, Promise<void>>();

  constructor(
    private readonly repository: AgentSessionRepository,
    private readonly config: AppConfigStore,
    private readonly createAdapter: AdapterFactory,
    private readonly emit: (event: AgentSessionEvent) => void,
    private readonly allowParallel = false,
    private readonly runtimeHomesRoot?: string,
  ) {}

  catalog(runtimeId: AgentRuntimeId): AgentSessionCatalog {
    const sessions = this.repository.list(runtimeId);
    const preference = this.config.get(runtimeId);
    return {
      sessions,
      deletedSessions: this.repository.listDeleted(runtimeId),
      selectedSessionId: sessions.some((item) => item.id === preference.selectedSessionId)
        ? preference.selectedSessionId : sessions[0]?.id ?? null,
      lastWorkspace: preference.lastWorkspace,
    };
  }

  events(id: string): AgentSessionEvent[] { return this.repository.events(id); }

  async create(runtimeId: AgentRuntimeId, workspace: string): Promise<AgentSessionSummary> {
    const canonical = await realpath(workspace);
    if (!(await stat(canonical)).isDirectory()) throw new Error("工作目录必须是文件夹");
    return this.serial(runtimeId, async () => {
      if (!this.allowParallel) await this.stopOtherSessions(runtimeId);
      const session = this.repository.create(runtimeId, canonical);
      await this.config.select(runtimeId, session.id, canonical);
      return session;
    });
  }

  async activate(id: string): Promise<void> {
    const runtimeId = this.repository.get(id).runtimeId;
    await this.serial(runtimeId, () => this.start(id));
  }

  async select(id: string): Promise<void> {
    const record = this.repository.get(id);
    await this.serial(record.runtimeId, () => this.config.select(record.runtimeId, id, record.workspace));
  }

  async delete(id: string): Promise<void> {
    const runtimeId = this.repository.get(id).runtimeId;
    await this.serial(runtimeId, async () => {
      const record = this.repository.get(id);
      if (busyPhases.has(record.phase)) throw new Error("会话仍在运行，请先完成或取消任务");
      await this.stop(id);
      this.repository.softDelete(id);
      if (this.config.get(runtimeId).selectedSessionId === id) {
        const fallback = this.repository.list(runtimeId)[0];
        if (fallback) await this.config.select(runtimeId, fallback.id, fallback.workspace);
        else await this.config.clearSelection(runtimeId);
      }
    });
  }

  async restore(id: string): Promise<void> {
    const runtimeId = this.repository.get(id, true).runtimeId;
    await this.serial(runtimeId, async () => {
      const restored = this.repository.restore(id);
      if (!this.config.get(runtimeId).selectedSessionId) {
        await this.config.select(runtimeId, restored.id, restored.workspace);
      }
    });
  }

  async purge(id: string): Promise<void> {
    const runtimeId = this.repository.get(id, true).runtimeId;
    await this.serial(runtimeId, async () => {
      const record = this.repository.get(id, true);
      if (!record.deletedAt) throw new Error("请先将会话移至最近删除");
      if (this.live.has(id)) throw new Error("会话仍在运行，不能彻底删除");
      let staged: string | null = null;
      let home: string | null = null;
      if (this.runtimeHomesRoot) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("会话标识无效，不能清理运行目录");
        const runtimeRoot = resolve(this.runtimeHomesRoot, record.runtimeId);
        home = resolve(runtimeRoot, id);
        if (!home.startsWith(runtimeRoot + sep)) throw new Error("运行目录不在受控范围内");
        for (const parent of [this.runtimeHomesRoot, runtimeRoot]) {
          try {
            if ((await lstat(parent)).isSymbolicLink()) throw new Error("运行目录包含符号链接，不能自动清理");
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        const stagingRoot = resolve(this.runtimeHomesRoot, ".deleting");
        await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
        const target = join(stagingRoot, `${id}-${randomUUID()}`);
        try { await rename(home, target); staged = target; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      try { this.repository.purge(id); }
      catch (error) {
        if (staged && home) await rename(staged, home);
        throw error;
      }
      if (staged) await rm(staged, { recursive: true, force: true });
    });
  }

  private async start(id: string): Promise<void> {
    const record = this.repository.get(id);
    if (this.live.has(id) && (record.phase === "error" || record.phase === "idle")) await this.stop(id);
    if (!this.live.has(id)) {
      if (!this.allowParallel) await this.stopOtherSessions(record.runtimeId);
      const adapter = this.createAdapter(record.runtimeId, id);
      const unsubscribe = adapter.onEvent((event) => this.forward(id, event));
      this.live.set(id, { adapter, unsubscribe });
      try {
        // Codex does not write a resumable rollout until the first turn starts.
        // An empty thread may have an id but thread/resume cannot load it later.
        const resumeRef = record.runtimeId === "codex" && record.lastPromptAt === null
          ? undefined : record.nativeRef ?? undefined;
        await adapter.start(record.workspace, resumeRef);
        const nativeRef = adapter.getResumeRef();
        if (!nativeRef) throw new Error("运行时未返回可恢复的会话标识");
        if (record.runtimeId !== "codex") this.repository.setNativeRef(id, nativeRef);
      } catch (error) {
        await this.stop(id);
        throw error;
      }
    }
    await this.config.select(record.runtimeId, id, record.workspace);
  }

  async send(id: string, prompt: string): Promise<void> {
    const text = prompt.trim();
    if (!text) throw new Error("请输入任务内容");
    const runtimeId = this.repository.get(id).runtimeId;
    await this.serial(runtimeId, async () => {
      await this.start(id);
      const record = this.repository.get(id);
      if (record.phase !== "ready") throw new Error("当前会话尚未就绪，或仍在执行上一轮任务");
      this.forward(id, {
        runtimeId, runId: randomUUID(), sequence: 0, at: new Date().toISOString(),
        source: "SelfMe Lab", kind: "user", text,
      });
      const adapter = this.live.get(id)!.adapter;
      await adapter.send(text);
      if (runtimeId === "codex") {
        const nativeRef = adapter.getResumeRef();
        if (!nativeRef) throw new Error("Codex 首轮任务未返回可恢复的会话标识");
        this.repository.setNativeRef(id, nativeRef);
      }
    });
  }

  async cancel(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error("会话未在运行");
    await live.adapter.cancel();
  }

  async respondApproval(id: string, requestId: string | number, optionId: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error("会话未在运行，审批已失效");
    await live.adapter.respondApproval(requestId, optionId);
  }

  isBusy(runtimeId: AgentRuntimeId): boolean {
    return [...this.live.keys()].some((id) => {
      const record = this.repository.get(id);
      return record.runtimeId === runtimeId && busyPhases.has(record.phase);
    });
  }

  async stopRuntime(runtimeId: AgentRuntimeId): Promise<void> {
    await this.serial(runtimeId, () => Promise.all([...this.live.keys()]
      .filter((id) => this.repository.get(id).runtimeId === runtimeId).map((id) => this.stop(id))).then(() => {}));
  }

  async stopAll(): Promise<void> {
    await Promise.all((["dsh", "codex", "pi", "kimi-code"] as const).map((runtimeId) => this.stopRuntime(runtimeId)));
  }

  private async serial<T>(runtimeId: AgentRuntimeId, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(runtimeId);
    const current = (previous ?? Promise.resolve()).catch(() => {}).then(action);
    const settled = current.then(() => {}, () => {});
    this.operations.set(runtimeId, settled);
    try { return await current; }
    finally { if (this.operations.get(runtimeId) === settled) this.operations.delete(runtimeId); }
  }

  private async stopOtherSessions(runtimeId: AgentRuntimeId): Promise<void> {
    for (const id of this.live.keys()) {
      const record = this.repository.get(id);
      if (record.runtimeId !== runtimeId) continue;
      if (busyPhases.has(record.phase)) throw new Error("当前任务仍在运行，请先完成或取消后切换会话");
      await this.stop(id);
    }
  }

  private async stop(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    try { await live.adapter.stop(); }
    finally { live.unsubscribe(); }
  }

  private forward(id: string, event: RunEvent): void {
    this.emit(this.repository.append(id, event));
  }
}
