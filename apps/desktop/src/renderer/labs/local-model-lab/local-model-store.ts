import { useSyncExternalStore } from "react";
import type { LocalModelEvent, LocalModelPreferences, LocalModelRun, LocalModelSnapshot } from "../../../../../../packages/contracts/src/local-model";
import type { DesktopBridge } from "../../../../../../packages/contracts/src/index";

export function localModelBridge(): DesktopBridge {
  if (!window.selfmeLab) throw new Error("请在 SelfMe Lab 桌面应用内运行本地模型实验");
  return window.selfmeLab;
}

interface LocalModelViewState {
  data: LocalModelSnapshot | null;
  loading: boolean;
  error: string | null;
  runs: Record<string, LocalModelRun | null | undefined>;
  drafts: Record<string, LocalModelDraft | undefined>;
  loadingRuns: Record<string, boolean | undefined>;
}
export interface LocalModelDraft { prompt: string; systemPrompt: string; }
let state: LocalModelViewState = { data: null, loading: false, error: null, runs: {}, drafts: {}, loadingRuns: {} };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let preferenceRevision = 0;
let pendingPreferences = 0;
let preferenceWrites: Promise<void> = Promise.resolve();
const runRequests = new Map<string, Promise<void>>();
let runCacheRevision = 0;
export function localModelExperimentKey(mode: LocalModelRun["mode"], models: readonly (string | null)[]): string {
  return JSON.stringify([mode, ...models.map((model) => model ? (model.includes(":") ? model : `${model}:latest`).toLowerCase() : null)]);
}
function runKey(run: LocalModelRun): string { return localModelExperimentKey(run.mode, run.outputs.map((output) => output.model)); }
export function getLocalModelDraft(key: string): LocalModelDraft {
  const run = state.runs[key];
  return state.drafts[key] ?? { prompt: run?.prompt ?? "", systemPrompt: run?.systemPrompt ?? "" };
}
export function setLocalModelDraft(key: string, draft: LocalModelDraft): void {
  update({ ...state, drafts: { ...state.drafts, [key]: draft } });
}
function update(next: LocalModelViewState): void { state = next; listeners.forEach((listener) => listener()); }

function acceptState(data: LocalModelSnapshot): void {
  const runs = { ...state.runs };
  if (data.latestRun) runs[runKey(data.latestRun)] = data.latestRun;
  if (data.activeRun) runs[runKey(data.activeRun)] = data.activeRun;
  update({ ...state, data: pendingPreferences && state.data ? { ...data, preferences: state.data.preferences } : data, runs, loading: false, error: null });
}

export function acceptLocalModelEvent(event: LocalModelEvent): void {
  if (event.type === "state") acceptState(event.state);
  if (event.type === "download" && state.data) update({ ...state, data: { ...state.data, download: event.download } });
  if (event.type === "run") update({ ...state, runs: { ...state.runs, [runKey(event.run)]: event.run }, data: state.data ? {
    ...state.data, activeRun: event.run.status === "running" ? event.run : null, latestRun: event.run,
  } : null });
}

export function attachLocalModelEvents(): () => void {
  return window.selfmeLab?.onLocalModelEvent(acceptLocalModelEvent) ?? (() => {});
}
export function useLocalModels(): LocalModelViewState {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
}
export function ensureLocalModelRun(mode: LocalModelRun["mode"], models: string[]): Promise<void> {
  const key = localModelExperimentKey(mode, models);
  if (state.runs[key] !== undefined || !window.selfmeLab) return Promise.resolve();
  const pending = runRequests.get(key); if (pending) return pending;
  const revision = runCacheRevision;
  update({ ...state, loadingRuns: { ...state.loadingRuns, [key]: true } });
  const request = localModelBridge().getLatestLocalModelRun(mode, models).then((run) => {
    // A delayed disk read may not overwrite a newer stream or a deleted record.
    if (revision === runCacheRevision && state.runs[key] === undefined) update({ ...state, runs: { ...state.runs, [key]: run } });
  }).catch((error: unknown) => {
    if (revision === runCacheRevision) update({ ...state, error: localModelError(error) });
  }).finally(() => {
    if (runRequests.get(key) === request) {
      runRequests.delete(key); update({ ...state, loadingRuns: { ...state.loadingRuns, [key]: false } });
    }
  });
  runRequests.set(key, request); return request;
}
export async function deleteLocalModelRun(id: string): Promise<void> {
  await localModelBridge().deleteLocalModelRun(id);
  runCacheRevision += 1; runRequests.clear();
  const runs = { ...state.runs };
  for (const [key, run] of Object.entries(runs)) if (run?.id === id) delete runs[key];
  update({ ...state, runs, loadingRuns: {} });
  await refreshLocalModels();
}
export function refreshLocalModels(): Promise<void> {
  if (loading) return loading;
  if (!window.selfmeLab) return Promise.resolve();
  update({ ...state, loading: true, error: null });
  loading = localModelBridge().getLocalModelState().then((data) => {
    acceptState(data);
    // Selection-specific records are read on demand by the page, not by global recency.
  }).catch((error: unknown) => update({ ...state, loading: false, error: localModelError(error) })).finally(() => { loading = null; });
  return loading;
}

export function saveLocalModelPreferences(preferences: LocalModelPreferences): Promise<void> {
  const revision = ++preferenceRevision;
  if (state.data) update({ ...state, data: { ...state.data, preferences } });
  pendingPreferences += 1;
  const write = preferenceWrites.then(async () => {
    try {
      await localModelBridge().saveLocalModelPreferences(preferences);
      if (revision === preferenceRevision) update({ ...state, error: null });
    } catch (error) {
      update({ ...state, error: localModelError(error) });
      throw error;
    } finally { pendingPreferences -= 1; }
  });
  preferenceWrites = write.catch(() => {});
  return write;
}

export function localModelError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /u, "");
}
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${bytes} B`;
}
export function formatModelDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 100) return "<0.1 s";
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round(ms % 60000 / 1000)}s`;
}
export const localModelStatus = { pending: "等待", running: "生成中", complete: "已完成", stopped: "已停止", error: "失败", interrupted: "已中断" } as const;
