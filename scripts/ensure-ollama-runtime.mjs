import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = join(root, "runtimes/ollama");
const manifest = JSON.parse(await readFile(join(runtime, "runtime.json"), "utf8"));
if (process.platform !== manifest.platform) throw new Error("当前 Ollama 内置运行包仅支持 macOS，请先准备对应平台的官方运行包");
const native = join(runtime, "native");
const executable = join(native, "ollama");
const stamp = join(native, ".verified.json");
try {
  const verified = JSON.parse(await readFile(stamp, "utf8"));
  if (verified.sha256 === manifest.sha256 && (await readdir(native)).includes("ollama")) {
    console.log(`Ollama ${manifest.version} 官方运行包已就绪`);
    process.exit(0);
  }
} catch { /* prepare the pinned official distribution */ }
const cache = join(root, ".cache/ollama", manifest.version);
await mkdir(cache, { recursive: true });
const archive = join(cache, "ollama-darwin.tgz");
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
let cached = false;
try { cached = await sha256(archive) === manifest.sha256; } catch {}
if (!cached) {
  console.log(`下载官方 Ollama ${manifest.version} 运行包…`);
  const download = spawnSync("curl", ["--fail", "--location", "--retry", "3", "--output", archive, manifest.archive], { stdio: "inherit" });
  if (download.error) throw download.error;
  if (download.status !== 0) throw new Error("Ollama 官方运行包下载失败");
}
if (await sha256(archive) !== manifest.sha256) throw new Error("Ollama 官方运行包 SHA-256 不匹配");
const extracted = join(cache, "extracted");
await rm(extracted, { recursive: true, force: true });
await mkdir(extracted, { recursive: true });
const unpack = spawnSync("tar", ["-xzf", archive, "-C", extracted], { stdio: "inherit" });
if (unpack.status !== 0) throw new Error("Ollama 运行包解压失败");
await rm(native, { recursive: true, force: true });
await cp(extracted, native, { recursive: true, verbatimSymlinks: true });
await chmod(executable, 0o755);
const { writeFile } = await import("node:fs/promises");
await writeFile(stamp, JSON.stringify({ version: manifest.version, sha256: manifest.sha256 }, null, 2));
await rm(extracted, { recursive: true, force: true });
console.log(`Ollama ${manifest.version} 官方运行包校验通过`);
