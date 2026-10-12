import type { RemoteAgentId, RemoteTerminalAccess } from "../../../../../../packages/contracts/src/remote-agent";

export function remoteSceneTabs(engine: RemoteAgentId) {
  return engine === "openclaw" ? ["desktop", "terminal", "files", "preview"] as const : ["browser", "files", "preview"] as const;
}
export function sceneTabDescription(engine: RemoteAgentId, tab: string): string | undefined {
  if (engine === "openclaw" && tab === "terminal") return "与桌面终端共用会话";
  if (engine === "openclaw" && tab === "desktop") return "操作远端桌面 · 网页在桌面 Chrome 中查看";
  if (engine === "openhands" && tab === "browser") return "与智能体共用浏览器画面 · 只读观察";
  return undefined;
}
export function terminalConnectionNotice({ connecting, connected, ended, error, accessError, access }: {
  connecting: boolean; connected: boolean; ended: boolean; error: string; accessError: string; access?: RemoteTerminalAccess;
}): { message: string; reconnect: boolean } | undefined {
  // The connecting overlay and shared terminal's native input warning each
  // describe their own state once; normal input needs no permanent UI banner.
  if (connecting) return undefined;
  const reconnect = ended || !connected;
  const message = error || accessError || (reconnect ? "终端连接已断开，重新连接后可恢复仍在运行的会话" : !access ? "正在同步输入状态…" : "");
  return message ? { message, reconnect } : undefined;
}
export function observerLabel(state: "loading" | "connected" | "error", editable: boolean): string {
  if (state === "loading") return "正在连接远端画面…";
  if (state === "error") return "画面连接已断开";
  return editable ? "可操作" : "只读观察";
}
export function desktopInputEnabled(active: boolean, granted: boolean, state: "loading" | "connected" | "error"): boolean {
  return active && granted && state === "connected";
}
