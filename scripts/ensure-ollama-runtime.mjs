import { chmod, lstat, mkdir, mkdtemp, readdir, readlink, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executableName, ollamaExecutableRelativePath, requireNativeTarget } from "../runtimes/platform.mjs";
import { downloadVerified, readJson, sha256, writeJsonAtomic } from "./lib/artifacts.mjs";
import { run } from "./lib/process.mjs";

export function ollamaArtifact(manifest, target) {
  const artifact = manifest.artifacts?.[target.key];
  if (manifest.schemaVersion !== 2 || !artifact || !/^ollama-[a-z0-9-]+\.(?:tgz|tar\.zst|zip)$/.test(artifact.archive) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`缺少 ${target.key} 的官方 Ollama 运行包`);
  return { ...artifact, url: new URL(artifact.archive, manifest.release).href };
}

export async function inventory(directory, prefix = "") {
  const hashes = {}, links = {};
  for (const item of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = `${prefix}${item.name}`;
    if (name === ".verified.json") continue;
    if (item.isDirectory()) {
      const child = await inventory(directory, `${name}/`); Object.assign(hashes, child.hashes); Object.assign(links, child.links);
    } else if (item.isFile()) hashes[name] = await sha256(join(directory, name));
    else if (item.isSymbolicLink()) {
      const value = await readlink(join(directory, name)), destination = resolve(directory, prefix, value), path = relative(directory, destination);
      if (isAbsolute(value) || isAbsolute(path) || path.startsWith(`..${sep}`) || path === "..") throw new Error("Ollama 运行包包含目录外符号链接，未安装");
      links[name] = value;
    } else throw new Error(`Ollama 运行包包含不支持的文件：${name}`);
  }
  return { hashes, links };
}

export async function verifyOllama(runtime, manifest, target = requireNativeTarget()) {
  const native = join(runtime, "native"), artifact = ollamaArtifact(manifest, target), receipt = await readJson(join(native, ".verified.json"));
  if (receipt.schemaVersion !== 2 || receipt.target !== target.key || receipt.version !== manifest.version || receipt.archiveSha256 !== artifact.sha256) throw new Error("Ollama 运行包平台或版本不匹配");
  const actual = await inventory(native);
  for (const group of ["hashes", "links"]) {
    const expected = receipt[group];
    if (!expected || Object.keys(expected).length !== Object.keys(actual[group]).length || Object.entries(actual[group]).some(([name, value]) => expected[name] !== value)) throw new Error("Ollama 运行包文件校验失败");
  }
  const executable = ollamaExecutableRelativePath(target.platform).replace(/^native\//, "");
  if (!actual.hashes[executable]) throw new Error(`Ollama 运行包缺少 ${executable}`);
}

export async function ensureOllama(args = [], root = fileURLToPath(new URL("../", import.meta.url))) {
  if (args.includes("--help")) { console.log("npm run ensure:ollama -- [--verify] [--plan] — 下载并校验当前平台的官方 Ollama 运行包；不下载模型、不安装系统服务、不改代理"); return; }
  const target = requireNativeTarget(), runtime = join(root, "runtimes/ollama"), manifest = await readJson(join(runtime, "runtime.json")), artifact = ollamaArtifact(manifest, target);
  if (args.includes("--plan")) { console.log(JSON.stringify({ target: target.key, version: manifest.version, ...artifact, executable: ollamaExecutableRelativePath() }, null, 2)); return; }
  try { await verifyOllama(runtime, manifest, target); console.log(`Ollama ${manifest.version} (${target.key}) 校验通过`); return; }
  catch (error) { if (args.includes("--verify")) throw error; }
  const cache = join(root, ".cache/ollama", manifest.version);
  const archive = await downloadVerified(artifact.url, join(cache, artifact.archive), artifact.sha256);
  const stage = await mkdtemp(join(cache, `extract-${target.key}-`)), native = join(runtime, "native"), backup = `${stage}-previous`;
  let previous = false, installed = false;
  try {
    await run("tar", ["-xf", archive, "-C", stage], { timeout: 300_000 });
    const executable = join(stage, ollamaExecutableRelativePath().replace(/^native\//, ""));
    if (target.platform !== "win32") await chmod(executable, 0o755);
    const files = await inventory(stage);
    if (!files.hashes[ollamaExecutableRelativePath().replace(/^native\//, "")]) throw new Error(`官方运行包缺少 ${executableName("ollama")}`);
    await writeJsonAtomic(join(stage, ".verified.json"), { schemaVersion: 2, target: target.key, version: manifest.version, archiveSha256: artifact.sha256, ...files });
    try {
      const info = await lstat(native);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("已有 Ollama 目录不是独立运行包，未覆盖");
      await rename(native, backup); previous = true;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(stage, native); installed = true;
    await verifyOllama(runtime, manifest, target);
    if (previous) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (installed) await rm(native, { recursive: true, force: true });
    if (previous) await rename(backup, native);
    throw error;
  } finally { await rm(stage, { recursive: true, force: true }); }
  console.log(`Ollama ${manifest.version} (${target.key}) 官方运行包已就绪`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureOllama(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
