import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { requireNativeTarget } from "../runtimes/platform.mjs";
import { run } from "./lib/process.mjs";
import { verifyCodex } from "./verify-codex-runtime.mjs";
import { supportsNode } from "./doctor.mjs";

export async function prepareRuntimes(args = []) {
  if (args.includes("--help")) { console.log("npm run prepare:runtimes -- [--codex|--verify-codex]\n准备当前平台的 DSH、Kimi、Qwen、Claude 和 Ollama。Pi 由根依赖恢复。--codex 在缺失时从源码编译 Codex；--verify-codex 仅校验，缺失则停止。所有缓存位于本项目。"); return; }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const target = requireNativeTarget();
  if (!supportsNode(process.versions.node)) throw new Error("需要 Node.js >=22.19.0，推荐 24 LTS");
  console.log(`准备桌面运行时 · ${target.key}`);
  for (const script of ["ensure-dsh-runtime.mjs", "ensure-kimi-runtime.mjs", "ensure-qwen-runtime.mjs", "ensure-claude-runtime.mjs", "ensure-ollama-runtime.mjs"]) {
    await run(process.execPath, [join(root, "scripts", script)], { cwd: root, timeout: 0 });
  }
  if (args.includes("--codex") || args.includes("--verify-codex")) {
    try { await verifyCodex(); }
    catch (error) {
      if (!args.includes("--codex")) throw new Error(`Codex 尚未准备：${error.message}\n先运行 npm run build:codex`);
      await run(process.execPath, [join(root, "scripts/build-codex-runtime.mjs")], { cwd: root, timeout: 0 });
    }
  }
  console.log("运行时准备完成；Codex 源码编译使用 npm run build:codex，远端镜像使用 npm run remote:build。");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareRuntimes(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
