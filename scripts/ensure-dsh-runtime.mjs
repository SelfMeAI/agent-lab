import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { transformDsh } from "../runtimes/dsh/steering-loader.mjs";
import { runNpm } from "./lib/process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = join(root, "runtimes/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
if (!existsSync(entry)) {
  await runNpm(["ci", "--prefix", join(root, "runtimes/dsh"), "--cache", join(root, ".cache/npm"), "--no-audit", "--no-fund"], { cwd: root });
}
if (!existsSync(entry)) throw new Error("DSH 运行时安装后仍缺少入口文件");
if (JSON.parse(readFileSync(join(root, "runtimes/dsh/node_modules/@deepseek-ai/dsh/package.json"), "utf8")).version !== "0.1.2-alpha.5") throw new Error("DSH 运行时版本与接入不匹配");
transformDsh(readFileSync(join(root, "runtimes/dsh/node_modules/@deepseek-ai/dsh-acp/lib/index.js"), "utf8"));
