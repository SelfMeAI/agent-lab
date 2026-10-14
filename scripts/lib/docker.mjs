import { access, constants } from "node:fs/promises";
import { dockerCliCandidates } from "../../runtimes/platform.mjs";
import { run } from "./process.mjs";

/** Read-only prerequisite check: never starts Docker or changes its context. */
export async function requireDocker({ platform = process.platform, env = process.env, accessFile = access, runCommand = run } = {}) {
  let executable;
  for (const candidate of dockerCliCandidates(platform, env)) {
    try { await accessFile(candidate, platform === "win32" ? constants.F_OK : constants.X_OK); executable = candidate; break; }
    catch { /* next supported installation location */ }
  }
  if (!executable) throw new Error("未找到 Docker 命令。请安装 Docker Desktop（macOS/Windows）或 Docker Engine（Linux），然后重新打开终端。Docker 仅用于远端实验室，其他实验室仍可使用。");
  let info;
  try {
    info = await runCommand(executable, ["info", "--format", "{{.ServerVersion}}|{{.OSType}}"], { env, capture: true, timeout: 15_000 });
  } catch {
    throw new Error("Docker 已安装，但服务未就绪或无法连接。请启动 Docker Desktop 或 Docker Engine，并等待启动完成；若已启动，请检查当前 Docker context 和访问权限。");
  }
  const [version, os] = info.trim().split("|");
  if (!version || !os) throw new Error("无法确认 Docker 服务状态，请检查当前 Docker context 后重试。");
  if (os !== "linux") throw new Error("远端服务需要 Linux 容器。请将 Docker 切换为 Linux 容器模式后重试。");
  return { executable, version };
}
