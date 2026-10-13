import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm } from "./lib/process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = join(root, "runtimes/qwen-code");
const pkg = join(runtime, "node_modules/@qwen-code/qwen-code");
if (!existsSync(join(pkg, "cli-entry.js"))) {
  await runNpm(["ci", "--prefix", runtime, "--cache", join(root, ".cache/npm"), "--no-audit", "--no-fund"], { cwd: root });
}
const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
if (version !== "0.24.6") throw new Error("Qwen Code 运行时版本与 ACP 接入不匹配");
// Verify the official native boundary exists; never silently downgrade Steer.
const chunks = join(pkg, "chunks");
if (!readdirSync(chunks).some(name => name.endsWith(".js") && readFileSync(join(chunks, name), "utf8").includes('MID_TURN_QUEUE_DRAIN_METHOD="craft/drainMidTurnQueue"'))) {
  throw new Error("Qwen Code 官方中途补充接口已改变，请先复核接入");
}
