import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");

async function migrateLegacyWorkspaceStorage(): Promise<void> {
  if (!window.selfmeLab) return;
  const workspaces: Record<string, string> = {};
  for (const runtimeId of ["dsh", "codex", "pi", "kimi-code"] as const) {
    const workspace = window.localStorage.getItem(`selfme-lab:${runtimeId}-workspace`);
    if (workspace) workspaces[runtimeId] = workspace;
  }
  if (Object.keys(workspaces).length === 0) return;
  await window.selfmeLab.migrateLegacyWorkspaces(workspaces);
  for (const runtimeId of Object.keys(workspaces)) window.localStorage.removeItem(`selfme-lab:${runtimeId}-workspace`);
}

void migrateLegacyWorkspaceStorage().catch((error: unknown) => {
  console.warn("旧版工作目录迁移未完成，原数据仍保留", error);
}).finally(() => createRoot(root).render(<App />));
