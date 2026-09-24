import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Rebuilds the bundled Codex runtime from pinned upstream source. This is an
// explicit, heavyweight maintainer command; regular users run the packaged app.
const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = join(root, "runtimes", "codex");
const manifestPath = join(runtime, "source.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const v8 = { repository: "https://github.com/denoland/rusty_v8.git", commit: "5c15a6995c9bb4bacd3e341b59fff32c909c80bf" };
const source = join(root, ".cache", "codex-source", manifest.commit);
const v8Source = join(root, ".cache", "rusty-v8", v8.commit);
const cargoRoot = join(source, "codex-rs");
const exe = join(cargoRoot, "target", "release", "codex");
const host = join(cargoRoot, "target", "release", "codex-code-mode-host");
const ripgrep = join(root, "runtimes", "dsh", "node_modules", "@vscode", `ripgrep-${process.platform}-${process.arch}`, "bin", "rg");

if (process.argv.includes("--help")) {
  console.log("npm run build:codex — compile the pinned official Codex CLI and Code Mode host; requires Git, Rust/Cargo and substantial free disk space.");
  process.exit(0);
}
if (process.platform !== "darwin" || process.arch !== "arm64" || manifest.target !== "darwin-arm64") {
  throw new Error("当前构建脚本仅支持已验收的 macOS Apple Silicon 运行时");
}

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

async function capture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} 退出码 ${code}: ${output.trim()}`)));
  });
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function checkout(repository, commit, directory, submodules = false) {
  if (!(await exists(join(directory, ".git")))) {
    await mkdir(directory, { recursive: true });
    await run("git", ["init"], directory);
    await run("git", ["remote", "add", "origin", repository], directory);
    await run("git", ["fetch", "--depth", "1", "origin", commit], directory);
    await run("git", ["checkout", "--detach", "FETCH_HEAD"], directory);
  }
  const actual = await capture("git", ["rev-parse", "HEAD"], directory);
  if (actual !== commit) throw new Error(`源码缓存版本不匹配：${directory}`);
  if (submodules) await run("git", ["submodule", "update", "--init", "--recursive"], directory);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

await capture("git", ["--version"], root);
await capture("cargo", ["--version"], root);
await checkout(manifest.repository, manifest.commit, source);
await checkout(v8.repository, v8.commit, v8Source, true);
await access(ripgrep, constants.X_OK);

console.log(`Building Codex CLI from ${manifest.repository}@${manifest.commit}`);
await run("cargo", ["build", "--release", "-p", "codex-cli"], cargoRoot);

// Code Mode's V8 sandbox requires a matching full rusty_v8 source build on
// Apple Silicon. Keep its source/build cache inside this project's .cache/.
const target = join(cargoRoot, "target", "release");
const env = {
  V8_FROM_SOURCE: "1",
  GN_ARGS: [process.env.GN_ARGS, "icu_use_data_file=false", "v8_use_external_startup_data=false"].filter(Boolean).join(" "),
};
if (await exists(join(target, "ninja_gn_binaries", "gn", "gn"))) env.GN = join(target, "ninja_gn_binaries", "gn", "gn");
if (await exists(join(target, "ninja_gn_binaries", "ninja", "ninja"))) env.NINJA = join(target, "ninja_gn_binaries", "ninja", "ninja");
if (await exists(join(target, "clang", "bin", "clang"))) env.CLANG_BASE_PATH = join(target, "clang");
console.log(`Building Codex Code Mode host from ${v8.repository}@${v8.commit}`);
await run("cargo", ["--config", `patch.crates-io.v8.path=${JSON.stringify(v8Source)}`, "build", "--release", "-p", "codex-code-mode-host"], cargoRoot, env);

const version = await capture(exe, ["--version"], cargoRoot);
if (!version.split(/\s+/u).includes(manifest.version)) throw new Error(`Codex 版本不匹配：${version}`);
const hostHelp = await capture(host, ["--help"], cargoRoot);
if (!hostHelp.includes("Usage: codex-code-mode-host")) throw new Error("Code Mode host 校验失败");

const files = {
  "bin/codex": exe,
  "bin/codex-code-mode-host": host,
  "codex-resources/codex-code-mode-host": host,
  "codex-path/rg": ripgrep,
};
for (const [relative, sourcePath] of Object.entries(files)) {
  const destination = join(runtime, relative);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(sourcePath, destination);
  await chmod(destination, 0o755);
}
await copyFile(join(source, "LICENSE"), join(runtime, "UPSTREAM-LICENSE"));
await copyFile(join(source, "NOTICE"), join(runtime, "UPSTREAM-NOTICE"));
await writeFile(join(runtime, "codex-package.json"), `${JSON.stringify({ layoutVersion: 1, version: manifest.version, target: manifest.target, variant: "codex", entrypoint: "bin/codex", resourcesDir: "codex-resources", pathDir: "codex-path" }, null, 2)}\n`);
const hashes = Object.fromEntries(await Promise.all(Object.keys(files).map(async (relative) => [relative, await sha256(join(runtime, relative))])));
await writeFile(manifestPath, `${JSON.stringify({ ...manifest, sha256: hashes, origin: `Built from pinned official source with scripts/build-codex-runtime.mjs; rusty_v8 ${v8.commit}.` }, null, 2)}\n`);
console.log("Codex 运行时构建完成；运行 npm run verify:codex 校验后再打包");
