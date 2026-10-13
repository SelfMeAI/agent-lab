import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireNativeTarget } from "../runtimes/platform.mjs";
import { run, runNpm } from "./lib/process.mjs";
import { doctor } from "./doctor.mjs";
import { prepareRuntimes } from "./prepare-runtimes.mjs";
import { readJson } from "./lib/artifacts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const platforms = { mac: "darwin", win: "win32", linux: "linux" };
export function packagePlan(platform, arch, directory = false) {
  const target = requireNativeTarget(platform, arch);
  const builderPlatform = platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux";
  const suffix = arch === "x64" ? "" : `-${arch}`;
  return { target, output: `${builderPlatform}${suffix}${platform === "darwin" ? "" : "-unpacked"}`,
    args: [`--${builderPlatform}`, `--${arch}`, ...(directory ? ["--dir"] : []), "--publish", "never"] };
}

export async function packageDesktop(args = []) {
  if (args.includes("--help")) { console.log("npm run package -- [--platform mac|win|linux] [--arch x64|arm64] [--dir] [--plan]\n必须在目标平台/架构原生构建，防止错装运行时。默认生成安装/分发文件；--dir 只生成可运行目录。不会上传发布。"); return; }
  const requested = args.includes("--platform") ? args[args.indexOf("--platform") + 1] : undefined;
  if (requested && !Object.hasOwn(platforms, requested)) throw new Error("平台可选 mac / win / linux");
  const platform = requested ? platforms[requested] : process.platform;
  const arch = args.includes("--arch") ? args[args.indexOf("--arch") + 1] : process.arch;
  const plan = packagePlan(platform, arch, args.includes("--dir"));
  if (args.includes("--plan")) { console.log(JSON.stringify(plan, null, 2)); return; }
  await doctor("package");
  await prepareRuntimes(["--verify-codex"]);
  await runNpm(["run", "build"], { cwd: root, timeout: 600_000 });
  const release = join(root, "release");
  // Remove only the selected native unpacked output, never the whole release
  // directory, other platform packages, or application data.
  for (const name of [plan.output, `${plan.output}.tmp`]) await rm(join(release, name), { recursive: true, force: true, maxRetries: 5 });
  await run(process.execPath, [join(root, "node_modules/electron-builder/out/cli/cli.js"), ...plan.args], { cwd: join(root, "apps/desktop"), env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" }, timeout: 0 });
  for (const name of [`${plan.output}.tmp`, ".icon-icns", ".icon-ico", "builder-debug.yml"]) await rm(join(release, name), { recursive: true, force: true, maxRetries: 5 });
  // There is no auto-updater/publish feed in this Lab. Keep manual distribution
  // artifacts only; don't retain differential-update sidecars for this build.
  const { version } = await readJson(join(root, "apps/desktop/package.json"));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("打包版本号无效");
  for (const ext of ["zip", "dmg", "exe"]) await rm(join(release, `Agent-Lab-${version}-${platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux"}-${arch}.${ext}.blockmap`), { force: true });
  console.log(`Agent Lab ${plan.target.key} 打包完成 · release/${plan.output}\n当前本地包未签名；Windows/Linux 需通过对应原生 CI 与设备验收。`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  packageDesktop(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
