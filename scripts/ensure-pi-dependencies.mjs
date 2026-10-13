import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { downloadNpmArchive, readJson } from "./lib/artifacts.mjs";
import { run } from "./lib/process.mjs";

// Pi 0.87.1's published npm-shrinkwrap.json takes precedence over the parent
// workspace lock. Restore the reviewed patch dependency explicitly so that
// the files actually packaged match the root lock, not just npm audit's view.
export async function ensurePiDependencies(root = fileURLToPath(new URL("../", import.meta.url))) {
  const sdk = join(root, "node_modules/@earendil-works/pi-coding-agent");
  if ((await readJson(join(sdk, "package.json"))).version !== "0.87.1") throw new Error("Pi SDK 版本已变化，请先复核依赖校正");
  const key = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
  const expected = (await readJson(join(root, "package-lock.json"))).packages[key];
  if (expected?.version !== "5.0.12" || expected.resolved !== "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz") throw new Error("Pi brace-expansion 安全依赖锁不匹配");
  const destination = join(sdk, "node_modules/brace-expansion");
  const current = (await readJson(join(destination, "package.json"))).version;
  if (current === expected.version) return;
  for (const directory of [join(root, "node_modules"), join(root, "node_modules/@earendil-works"), sdk, join(sdk, "node_modules")]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Pi 依赖目录不是项目内的独立目录，未修改");
  }
  if (current !== "5.0.9" || (await lstat(destination)).isSymbolicLink()) throw new Error("Pi 内部依赖与已复核发行包不一致，未覆盖");
  const cache = join(root, ".cache/pi-dependencies"); await mkdir(cache, { recursive: true });
  const archive = await downloadNpmArchive(expected.resolved, join(cache, "brace-expansion-5.0.12.tgz"), expected.integrity);
  const stage = await mkdtemp(join(cache, "extract-")), backup = `${stage}-previous`;
  let moved = false, installed = false;
  try {
    await run("tar", ["-xf", archive, "-C", stage]);
    const pkg = await readJson(join(stage, "package/package.json"));
    if (pkg.name !== "brace-expansion" || pkg.version !== expected.version) throw new Error("Pi 安全依赖包校验失败");
    await rename(destination, backup); moved = true;
    await rename(join(stage, "package"), destination); installed = true;
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (installed) await rm(destination, { recursive: true, force: true });
    if (moved) await rename(backup, destination);
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
  console.log("Pi SDK 的 brace-expansion 已恢复为校验过的 5.0.12 安全依赖");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensurePiDependencies().catch(error => { console.error(error.message); process.exitCode = 1; });
}
