import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codexRuntimeFiles, executableName, requireNativeTarget } from "../runtimes/platform.mjs";
import { readJson, verifyFileHashes } from "./lib/artifacts.mjs";

export async function verifyCodex({ root = fileURLToPath(new URL("../", import.meta.url)), runtime = join(root, "runtimes/codex"), target = requireNativeTarget() } = {}) {
  const source = await readJson(join(root, "runtimes/codex/source.json"));
  const marker = await readJson(join(runtime, "codex-package.json"));
  const receipt = await readJson(join(runtime, "build-receipt.json"));
  if (marker.layoutVersion !== 1 || marker.version !== source.version || marker.target !== target.rustTarget
    || marker.entrypoint !== `bin/${executableName("codex", target.platform)}` || marker.resourcesDir !== "codex-resources" || marker.pathDir !== "codex-path") throw new Error("Codex 运行包的平台、版本或布局不匹配，请在当前平台运行 npm run build:codex");
  if (receipt.schemaVersion !== 1 || receipt.commit !== source.commit || receipt.version !== source.version || receipt.target !== target.key || receipt.rustToolchain !== source.rustToolchain || receipt.v8Version !== source.v8.version) throw new Error("Codex 编译记录与固定源码不匹配");
  const files = codexRuntimeFiles(target.platform);
  await verifyFileHashes(runtime, receipt.files, files);
  for (const path of files) await access(join(runtime, path), target.platform === "win32" ? constants.F_OK : constants.X_OK);
  return { version: source.version, target: target.key, provenance: "source-build" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) console.log("npm run verify:codex — 验证当前平台的 Codex、Code Mode host、搜索和沙箱辅助文件；缺失时运行 npm run build:codex");
  else verifyCodex().then(result => console.log(`Codex ${result.version} (${result.target}) 校验通过 · ${result.provenance}`)).catch(error => { console.error(`Codex 尚未准备或校验失败：${error.message}\n请运行 npm run build:codex`); process.exitCode = 1; });
}
