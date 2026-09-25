import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const metadata = JSON.parse(readFileSync(join(root, "runtimes/kimi-code/source.json"), "utf8"));
const binary = join(root, "runtimes/kimi-code/bin/kimi");
const cache = join(root, ".cache/kimi-code", metadata.version);
const archive = join(cache, metadata.archive);

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(`Kimi Code ${metadata.target} 运行时无法用于 ${process.platform}-${process.arch}`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}`);
}

if (existsSync(binary)) {
  if ((await sha256(binary)) !== metadata.binarySha256) {
    throw new Error("Kimi Code 运行时与锁定校验值不符；请先检查 runtimes/kimi-code/bin/kimi");
  }
  process.exit(0);
}

mkdirSync(cache, { recursive: true });
if (!existsSync(archive)) {
  const url = `https://github.com/MoonshotAI/kimi-code/releases/download/${encodeURIComponent(metadata.releaseTag)}/${metadata.archive}`;
  run("curl", ["--fail", "--location", "--show-error", "--silent", url, "--output", archive]);
}
if ((await sha256(archive)) !== metadata.archiveSha256) {
  throw new Error("Kimi Code 官方发布包 SHA-256 校验失败，未安装运行时");
}

const listing = spawnSync("tar", ["-tzf", archive], { cwd: root, encoding: "utf8" });
if (listing.error) throw listing.error;
if (listing.status !== 0 || listing.stdout.trim() !== "kimi") {
  throw new Error("Kimi Code 发布包内容不符合预期，未解压");
}

mkdirSync(join(root, "runtimes/kimi-code/bin"), { recursive: true });
run("tar", ["-xzf", archive, "-C", join(root, "runtimes/kimi-code/bin")]);
if (!statSync(binary).isFile() || (await sha256(binary)) !== metadata.binarySha256) {
  throw new Error("Kimi Code 可执行文件 SHA-256 校验失败");
}
run(binary, ["--version"]);
