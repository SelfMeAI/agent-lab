import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = join(root, "runtimes/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
if (!existsSync(entry)) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["ci", "--prefix", join(root, "runtimes/dsh"), "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!existsSync(entry)) throw new Error("DSH 运行时安装后仍缺少入口文件");
