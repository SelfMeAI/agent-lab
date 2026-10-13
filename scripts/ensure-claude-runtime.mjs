import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executableName, requireNativeTarget } from "../runtimes/platform.mjs";
import { copyAtomic, downloadNpmArchive, readJson } from "./lib/artifacts.mjs";
import { run } from "./lib/process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function ensureClaude() {
  const runtime = join(root, "runtimes/claude"), manifest = await readJson(join(runtime, "runtime.json")), platform = requireNativeTarget().key;
  const pkgName = `@anthropic-ai/claude-agent-sdk-${platform}`;
  const locked = (await readJson(join(root, "package-lock.json"))).packages[`node_modules/${pkgName}`];
  if (!locked || locked.version !== manifest.sdkVersion || !locked.resolved?.startsWith(`https://registry.npmjs.org/${pkgName}/-/`)) throw new Error("Claude 官方平台包的版本或来源与锁文件不匹配");
  const sdk = await readJson(join(root, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"));
  if (sdk.version !== manifest.sdkVersion) throw new Error("请先运行 npm ci，恢复匹配的 Claude Agent SDK");
  // npm treats failed optional downloads as a successful install. Restore the
  // exact official package explicitly and validate the committed npm SRI;
  // never rely on the user's global Claude installation or change root locks.
  const cache = join(root, ".cache/claude", manifest.sdkVersion);
  const archive = await downloadNpmArchive(locked.resolved, join(cache, `${platform}.tgz`), locked.integrity);
  const stage = await mkdtemp(join(cache, `extract-${platform}-`));
  try {
    await run("tar", ["-xf", archive, "-C", stage], { timeout: 300_000 });
    const source = join(stage, "package"), pkg = await readJson(join(source, "package.json"));
    if (pkg.name !== pkgName || pkg.version !== manifest.sdkVersion) throw new Error("Claude 平台包校验失败");
    const executable = executableName("claude");
    const version = await run(join(source, executable), ["--version"], { capture: true });
    if (!version.split(/\s+/).includes(manifest.claudeVersion)) throw new Error(`Claude CLI 版本不匹配：${version}`);
    await mkdir(join(runtime, "bin"), { recursive: true });
    await copyAtomic(join(source, executable), join(runtime, "bin", executable));
    if (process.platform !== "win32") await chmod(join(runtime, "bin", executable), 0o755);
    await copyAtomic(join(source, "LICENSE.md"), join(runtime, "LICENSE.md"));
  } finally { await rm(stage, { recursive: true, force: true }); }
  console.log(`Claude Agent ${manifest.claudeVersion} (${platform}) 官方运行包已就绪`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) console.log("npm run ensure:claude — 从官方 npm 平台包恢复固定 Claude 可执行文件，并验证锁文件 SRI；不使用全局安装");
  else ensureClaude().catch(error => { console.error(error.message); process.exitCode = 1; });
}
