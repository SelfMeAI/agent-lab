import type { RemoteAgentId } from "../../../../../../packages/contracts/src/remote-agent";

export function remoteSceneTabs(engine: RemoteAgentId) {
  return engine === "openclaw" ? ["desktop", "terminal", "files", "preview"] as const : ["browser", "files", "preview"] as const;
}
export function observerLabel(state: "loading" | "connected" | "error", editable: boolean): string {
  if (state === "loading") return "正在连接远端画面…";
  if (state === "error") return "画面连接已断开";
  return editable ? "LIVE · 可操作" : "LIVE · 只读观察";
}
export function desktopInputEnabled(active: boolean, granted: boolean, state: "loading" | "connected" | "error"): boolean {
  return active && granted && state === "connected";
}
