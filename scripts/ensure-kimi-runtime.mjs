import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformKimi } from "../runtimes/kimi-code/steering-loader.mjs";
import { runNpm } from "./lib/process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = join(root, "runtimes/kimi-code");
const entry = join(runtime, "node_modules/@moonshot-ai/kimi-code/dist/main.mjs");
if (!existsSync(entry)) {
  await runNpm(["ci", "--prefix", runtime, "--cache", join(root, ".cache/npm"), "--no-audit", "--no-fund"], { cwd: root });
}
const version = JSON.parse(readFileSync(join(runtime, "node_modules/@moonshot-ai/kimi-code/package.json"), "utf8")).version;
if (version !== "2.1.1") throw new Error("Kimi Code 运行时版本与 steering bridge 不匹配");
transformKimi(readFileSync(entry, "utf8"));
