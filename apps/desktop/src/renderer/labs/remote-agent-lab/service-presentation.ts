import type { RemoteServiceState } from "../../../../../../packages/contracts/src/remote-agent";

export function remoteServiceLabel(state?: RemoteServiceState): string {
  if (!state) return "读取服务状态…";
  if (state.phase === "starting") return "正在启动…";
  if (state.phase === "stopping") return "正在停止…";
  if (state.phase === "ready") return "服务运行中";
  if (!state.dockerAvailable) return "Docker 未就绪";
  if (state.phase === "error") return state.running ? "运行中 · 连接异常" : "服务异常";
  if (!state.imageReady) return "尚未构建服务";
  return "服务未启动";
}
export function remoteError(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}
