import { spawn } from "node:child_process";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const engines = new Set(["openhands", "openclaw"]);

export function validateLock(value, engine) {
  if (!engines.has(engine) || value?.schemaVersion !== 1 || value.engine !== engine || !Array.isArray(value.sources) || !value.sources.length) {
    throw new Error("远端源码锁文件无效");
  }
  const ids = new Set();
  for (const source of value.sources) {
    if (!/^[a-z][a-z0-9-]*$/.test(source.id) || ids.has(source.id) || !/^[a-f0-9]{40}$/.test(source.commit ?? "") || !/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/.test(source.repository ?? "") || typeof source.version !== "string" || !source.version || typeof source.ref !== "string" || !source.ref) {
      throw new Error("源码必须具有唯一标识、官方仓库和固定提交");
    }
    ids.add(source.id);
  }
  return value;
}

export async function readLock(engine, root = projectRoot) {
  if (!engines.has(engine)) throw new Error("请选择 openhands 或 openclaw");
  return validateLock(JSON.parse(await readFile(join(root, "services", "remote-agent", engine, "upstream.lock.json"), "utf8")), engine);
}

export function run(command, args, cwd, { capture = false, timeout = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let output = "";
    if (capture) {
      child.stdout.on("data", data => { output = (output + data.toString()).slice(-128_000); });
      child.stderr.on("data", data => { output = (output + data.toString()).slice(-128_000); });
    }
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} 失败（${signal ?? code}）${capture ? `：${output.trim()}` : ""}`));
    });
  });
}

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function ensureSource(engine, source, { root = projectRoot, verifyOnly = false } = {}) {
  const upstream = join(root, "services", "remote-agent", engine, "upstream");
  const directory = join(upstream, source.id);
  for (const path of [upstream, directory]) {
    const stat = await exists(path);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`源码路径不是独立目录：${path}`);
  }
  const gitDirectory = await exists(join(directory, ".git"));
  if (!gitDirectory) {
    if (verifyOnly) throw new Error(`${engine}/${source.id} 尚未获取源码`);
    if (await exists(directory)) throw new Error(`已有目录不是源码仓库，未覆盖：${directory}`);
    await mkdir(dirname(directory), { recursive: true });
    await run("git", ["init", "--quiet", directory], root);
    await run("git", ["remote", "add", "origin", source.repository], directory);
  }
  const origin = await run("git", ["remote", "get-url", "origin"], directory, { capture: true });
  if (origin !== source.repository) throw new Error(`源码仓库不匹配，未修改：${directory}`);
  const dirty = await run("git", ["status", "--porcelain", "--untracked-files=all"], directory, { capture: true });
  if (dirty) throw new Error(`源码内存在修改，请先保存为扩展或补丁；未覆盖：${directory}`);
  let commit = "";
  try { commit = await run("git", ["rev-parse", "--verify", "HEAD"], directory, { capture: true }); } catch { /* interrupted initial fetch may be retried */ }
  if (commit && commit !== source.commit) throw new Error(`源码版本不匹配，未切换或覆盖：${directory}`);
  if (!commit) {
    if (verifyOnly) throw new Error(`源码尚未检出：${directory}`);
    await run("git", ["fetch", "--depth", "1", "origin", source.commit], directory);
    await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], directory);
    commit = await run("git", ["rev-parse", "HEAD"], directory, { capture: true });
  }
  if (commit !== source.commit) throw new Error(`固定提交校验失败：${directory}`);
  return directory;
}

export async function sourceMain(args) {
  if (args.includes("--help")) {
    console.log("npm run remote:source -- <openhands|openclaw> [--verify] [--source app|sdk|gateway]");
    return;
  }
  const engine = args[0];
  const lock = await readLock(engine);
  const selection = args.includes("--source") ? args[args.indexOf("--source") + 1] : undefined;
  const sources = selection ? lock.sources.filter(source => source.id === selection) : lock.sources;
  if (!sources.length) throw new Error("源码标识不在锁文件中");
  for (const source of sources) {
    const path = await ensureSource(engine, source, { verifyOnly: args.includes("--verify") });
    console.log(`${engine}/${source.id} · ${source.version} · ${source.commit}\n${path}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sourceMain(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
