import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformKimi } from "../runtimes/kimi-code/steering-loader.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = join(root, "runtimes/kimi-code");
const entry = join(runtime, "node_modules/@moonshot-ai/kimi-code/dist/main.mjs");
if (!existsSync(entry)) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--prefix", runtime, "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const version = JSON.parse(readFileSync(join(runtime, "node_modules/@moonshot-ai/kimi-code/package.json"), "utf8")).version;
if (version !== "2.1.1") throw new Error("Kimi Code 运行时版本与 steering bridge 不匹配");
transformKimi(readFileSync(entry, "utf8"));
