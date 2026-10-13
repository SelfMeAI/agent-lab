import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run as runProcess } from "../lib/process.mjs";
import { ensureCheckout } from "../lib/source-checkout.mjs";

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
  return runProcess(command, args, { cwd, capture, timeout });
}

export async function ensureSource(engine, source, { root = projectRoot, verifyOnly = false } = {}) {
  if (!engines.has(engine) || !/^[a-z][a-z0-9-]*$/.test(source.id)) throw new Error("源码路径标识无效");
  return ensureCheckout({ root, repository: source.repository, commit: source.commit,
    directory: join(root, "services", "remote-agent", engine, "upstream", source.id), verifyOnly });
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
