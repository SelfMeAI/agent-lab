import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codexRuntimeFiles, executableName, requireNativeTarget } from "../runtimes/platform.mjs";
import { copyAtomic, downloadVerified, readJson, sha256, writeJsonAtomic } from "./lib/artifacts.mjs";
import { run } from "./lib/process.mjs";
import { ensureCheckout } from "./lib/source-checkout.mjs";
import { doctor } from "./doctor.mjs";
import { verifyCodex } from "./verify-codex-runtime.mjs";
import { prepareCodexBuildSource } from "./lib/codex-lock.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function codexBuildPlan(manifest, target) {
  const v8 = manifest.v8, hashes = v8?.artifacts?.[target.rustTarget];
  if (!hashes || v8.profile !== "ptrcomp_sandbox_release" || !/^\d+\.\d+\.\d+$/.test(v8.version)) throw new Error("缺少目标平台的固定 V8 依赖");
  const archive = target.platform === "win32" ? `rusty_v8_${v8.profile}_${target.rustTarget}.lib.gz` : `librusty_v8_${v8.profile}_${target.rustTarget}.a.gz`;
  const binding = `src_binding_${v8.profile}_${target.rustTarget}.rs`;
  const binaries = ["codex", "codex-code-mode-host", ...(target.platform === "linux" ? ["bwrap"] : []),
    ...(target.platform === "win32" ? ["codex-command-runner", "codex-windows-sandbox-setup"] : [])];
  return { target, archive, binding, hashes, binaries, files: codexRuntimeFiles(target.platform),
    baseUrl: `https://github.com/openai/codex/releases/download/rusty-v8-v${v8.version}`,
    cargoArgs: [`+${manifest.rustToolchain}`, "build", "--locked", "--target", target.rustTarget, "--profile", "release", ...binaries.flatMap(name => ["--bin", name])] };
}

export async function buildCodex(args = []) {
  if (args.includes("--help")) {
    console.log("npm run build:codex -- [--plan] [--jobs N]\n在当前平台从固定官方源码编译 Codex、Code Mode host 和平台辅助程序；不复制已安装的 Codex。先运行 npm run doctor -- --scope codex。首次完整编译耗时较长，缓存保留在项目 .cache/ 中。"); return;
  }
  const target = requireNativeTarget(), runtime = join(root, "runtimes/codex");
  const manifest = await readJson(join(runtime, "source.json")), plan = codexBuildPlan(manifest, target);
  if (args.includes("--plan")) { console.log(JSON.stringify({ source: { repository: manifest.repository, commit: manifest.commit }, ...plan }, null, 2)); return; }
  await doctor("codex");
  const source = await ensureCheckout({ root, directory: join(root, ".cache/codex-source", manifest.commit), repository: manifest.repository, commit: manifest.commit });
  const { cargoRoot, lockNormalized } = await prepareCodexBuildSource({ root, source, commit: manifest.commit, toolchain: manifest.rustToolchain });
  const toolchain = await readFile(join(cargoRoot, "rust-toolchain.toml"), "utf8"), cargo = await readFile(join(cargoRoot, "Cargo.toml"), "utf8");
  if (!toolchain.includes(`channel = "${manifest.rustToolchain}"`) || !cargo.includes(`v8 = "=${manifest.v8.version}"`)) throw new Error("固定源码的工具链或 V8 版本与锁文件不一致");
  const dependencies = join(root, ".cache/codex-v8", manifest.v8.version, target.key);
  console.log(`准备官方 V8 ${manifest.v8.version} 依赖（校验 archive 和 binding）`);
  const archive = await downloadVerified(`${plan.baseUrl}/${plan.archive}`, join(dependencies, plan.archive), plan.hashes.archive);
  const binding = await downloadVerified(`${plan.baseUrl}/${plan.binding}`, join(dependencies, plan.binding), plan.hashes.binding);
  const output = join(root, ".cache/codex-build", manifest.commit, target.key);
  const buildEnv = { CARGO_TARGET_DIR: output, RUSTY_V8_ARCHIVE: archive, RUSTY_V8_SRC_BINDING_PATH: binding, V8_FROM_SOURCE: "0" };
  const jobs = args.includes("--jobs") ? args[args.indexOf("--jobs") + 1] : undefined;
  if (jobs && !/^[1-9]\d?$/.test(jobs)) throw new Error("--jobs 必须是 1–99 的整数");
  console.log(`从源码编译 Codex ${manifest.version} (${target.key}) · ${manifest.commit}`);
  await run("cargo", [...plan.cargoArgs, ...(jobs ? ["--jobs", jobs] : [])], { cwd: cargoRoot, env: buildEnv, timeout: 0 });
  const built = join(output, target.rustTarget, "release");
  const version = await run(join(built, executableName("codex")), ["--version"], { capture: true });
  if (!version.split(/\s+/u).includes(manifest.version)) throw new Error(`Codex 版本不匹配：${version}`);
  if (!(await run(join(built, executableName("codex-code-mode-host")), ["--help"], { capture: true })).includes("Usage: codex-code-mode-host")) throw new Error("Code Mode host 校验失败");
  const ripgrep = join(root, "runtimes/dsh/node_modules/@vscode", `ripgrep-${target.platform}-${target.arch}`, "bin", executableName("rg"));
  await run(ripgrep, ["--version"], { capture: true });
  await mkdir(join(root, ".cache/codex-stage"), { recursive: true });
  const stage = await mkdtemp(join(root, ".cache/codex-stage", `${target.key}-`));
  try {
    for (const path of plan.files) {
      const input = path.startsWith("codex-path/") ? ripgrep : join(built, path.split("/").at(-1));
      await copyAtomic(input, join(stage, path));
      if (target.platform !== "win32") await chmod(join(stage, path), 0o755);
    }
    const hashes = Object.fromEntries(await Promise.all(plan.files.map(async path => [path, await sha256(join(stage, path))])));
    const marker = { layoutVersion: 1, version: manifest.version, target: target.rustTarget, variant: "codex", entrypoint: `bin/${executableName("codex")}`, resourcesDir: "codex-resources", pathDir: "codex-path" };
    const receipt = { schemaVersion: 1, version: manifest.version, commit: manifest.commit, target: target.key, rustToolchain: manifest.rustToolchain, v8Version: manifest.v8.version, lockNormalized, files: hashes };
    await writeJsonAtomic(join(stage, "codex-package.json"), marker);
    await writeJsonAtomic(join(stage, "build-receipt.json"), receipt);
    await verifyCodex({ root, runtime: stage });
    for (const path of plan.files) {
      await copyAtomic(join(stage, path), join(runtime, path));
      if (target.platform !== "win32") await chmod(join(runtime, path), 0o755);
    }
    for (const [input, output] of [["LICENSE", "UPSTREAM-LICENSE"], ["NOTICE", "UPSTREAM-NOTICE"]]) await copyAtomic(join(source, input), join(runtime, output));
    await copyAtomic(join(root, "runtimes/dsh/node_modules/@vscode", `ripgrep-${target.platform}-${target.arch}`, "LICENSE"), join(runtime, "RIPGREP-LICENSE"));
    // Install receipts last: a partial installation must fail verification.
    await writeJsonAtomic(join(runtime, "codex-package.json"), marker);
    await writeJsonAtomic(join(runtime, "build-receipt.json"), receipt);
    await verifyCodex({ root });
  } finally { await rm(stage, { recursive: true, force: true }); }
  console.log("Codex 源码编译与运行包校验完成");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildCodex(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
