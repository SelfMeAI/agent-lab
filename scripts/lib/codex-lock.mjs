import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "./process.mjs";

// Release tags bump workspace.package.version without refreshing every local
// package entry in Cargo.lock. Normalize ONLY local workspace versions, never
// registry versions/checksums. cargo --locked still guards the dependency graph.
export function normalizeWorkspaceLock(lock, packages) {
  const versions = new Map(packages.filter(pkg => pkg.source === null).map(pkg => [pkg.name, pkg.version]));
  const replacements = new Map();
  const parts = lock.split(/(?=^\[\[package\]\]$)/m).map(part => {
    if (!part.startsWith("[[package]]") || /^source = /m.test(part)) return part;
    const name = part.match(/^name = "([^"]+)"$/m)?.[1], old = part.match(/^version = "([^"]+)"$/m)?.[1], version = versions.get(name);
    if (!version || version === old) return part;
    replacements.set(`${name} ${old}`, `${name} ${version}`);
    return part.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  });
  return parts.join("").replace(/^ "([^"]+)",$/gm, (line, value) => replacements.has(value) ? ` "${replacements.get(value)}",` : line);
}

export async function prepareCodexBuildSource({ root, source, commit, toolchain }) {
  const directory = join(root, ".cache/codex-build-source", commit);
  await mkdir(dirname(directory), { recursive: true });
  let exists = false;
  try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Codex 构建源码必须是独立目录"); exists = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!exists) await run("git", ["worktree", "add", "--quiet", "--detach", directory, commit], { cwd: source });
  if (await run("git", ["rev-parse", "HEAD"], { cwd: directory, capture: true }) !== commit) throw new Error("Codex 构建源码提交不匹配");
  const cargoRoot = join(directory, "codex-rs");
  const original = await readFile(join(source, "codex-rs/Cargo.lock"), "utf8");
  const metadata = JSON.parse(await run("cargo", [`+${toolchain}`, "metadata", "--no-deps", "--format-version", "1"], { cwd: cargoRoot, capture: true, maxBuffer: 4_000_000 }));
  const normalized = normalizeWorkspaceLock(original, metadata.packages);
  const dirty = await run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: directory, capture: true });
  const current = await readFile(join(cargoRoot, "Cargo.lock"), "utf8");
  if (dirty && (dirty !== "M codex-rs/Cargo.lock" || current !== normalized)) throw new Error("Codex 构建源码存在未识别修改，未覆盖");
  if (current !== normalized) await writeFile(join(cargoRoot, "Cargo.lock"), normalized);
  return { cargoRoot, lockNormalized: normalized !== original };
}
