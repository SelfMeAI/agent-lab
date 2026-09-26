import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = join(root, "runtimes/qwen-code");
const pkg = join(runtime, "node_modules/@qwen-code/qwen-code");
if (!existsSync(join(pkg, "cli-entry.js"))) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--prefix", runtime, "--cache", join(root, ".cache/npm"), "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
if (version !== "0.24.6") throw new Error("Qwen Code 运行时版本与 ACP 接入不匹配");
// Verify the official native boundary exists; never silently downgrade Steer.
const chunks = join(pkg, "chunks");
if (!readdirSync(chunks).some(name => name.endsWith(".js") && readFileSync(join(chunks, name), "utf8").includes('MID_TURN_QUEUE_DRAIN_METHOD="craft/drainMidTurnQueue"'))) {
  throw new Error("Qwen Code 官方中途补充接口已改变，请先复核接入");
}
