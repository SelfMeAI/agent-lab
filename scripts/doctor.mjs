import { pathToFileURL } from "node:url";
import { requireNativeTarget } from "../runtimes/platform.mjs";
import { readJson } from "./lib/artifacts.mjs";
import { run } from "./lib/process.mjs";
import { requireDocker } from "./lib/docker.mjs";

export function supportsNode(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || major === 22 && minor >= 19;
}

export async function doctor(scope = "desktop") {
  if (!["desktop", "codex", "remote", "package", "all"].includes(scope)) throw new Error("检查范围：desktop / codex / remote / package / all");
  const target = requireNativeTarget(), issues = [];
  console.log(`Agent Lab 环境检查 · ${scope} · ${target.key}`);
  async function check(label, command, args, hint) {
    try { const value = await run(command, args, { capture: true, timeout: 15_000 }); console.log(`✓ ${label}${value ? ` · ${value.split(/\r?\n/)[0].slice(0, 160)}` : ""}`); }
    catch { issues.push(`${label}：${hint}`); console.log(`✗ ${label}`); }
  }
  if (supportsNode(process.versions.node)) console.log(`✓ Node.js ${process.versions.node}（最低 22.19.0）`);
  else issues.push("Node.js：请安装 Node.js 24 LTS 或更新的受支持版本，最低 22.19.0");
  await check("Git", "git", ["--version"], "安装 Git，并确保命令可从当前终端运行");
  if (["desktop", "codex", "package", "all"].includes(scope)) await check("curl", "curl", ["--version"], "运行时下载需要 curl；Windows 10/11 通常已包含");
  if (["desktop", "package", "all"].includes(scope)) {
    await check("tar", "tar", ["--version"], "运行时解压需要 tar；Windows 10/11 通常已包含 bsdtar");
    if (target.platform === "linux") await check("zstd", "zstd", ["--version"], "安装 zstd，用于解压官方 Ollama .tar.zst 运行包");
  }
  if (["codex", "all"].includes(scope)) {
    const manifest = await readJson(new URL("../runtimes/codex/source.json", import.meta.url));
    await check(`Rust ${manifest.rustToolchain}`, "rustup", ["run", manifest.rustToolchain, "rustc", "--version"], `安装 rustup 后执行 rustup toolchain install ${manifest.rustToolchain} --profile minimal`);
    await check("Cargo", "rustup", ["run", manifest.rustToolchain, "cargo", "--version"], "Rust 工具链必须包含 Cargo");
    if (target.platform === "darwin") await check("Xcode Command Line Tools", "xcrun", ["--find", "clang"], "执行 xcode-select --install，并完成系统安装弹窗");
    if (target.platform === "win32") await check("MSVC linker", "where.exe", ["link.exe"], "安装 Visual Studio 2022 C++ Build Tools 和 Windows SDK，在匹配架构的 Developer PowerShell 中构建");
    if (target.platform === "linux") {
      await check("C/C++ toolchain", "c++", ["--version"], "Debian/Ubuntu：sudo apt-get install build-essential");
      await check("pkg-config / OpenSSL", "pkg-config", ["--modversion", "openssl"], "Debian/Ubuntu：sudo apt-get install pkg-config libssl-dev");
    }
  }
  if (["remote", "all"].includes(scope)) {
    try { const docker = await requireDocker(); console.log(`✓ Docker Engine · ${docker.version} · Linux 容器`); }
    catch (error) { issues.push(error.message); console.log("✗ Docker Engine"); }
  }
  if (issues.length) throw new Error(`环境尚未就绪：\n${issues.map(value => `- ${value}`).join("\n")}\n本命令不会自动安装系统软件或改动网络设置。`);
  console.log("环境检查通过");
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help")) console.log("npm run doctor -- [--scope desktop|codex|remote|package|all] — 只读环境检查，不安装软件、不改代理");
  else doctor(process.argv.includes("--scope") ? process.argv[process.argv.indexOf("--scope") + 1] : "desktop").catch(error => { console.error(error.message); process.exitCode = 1; });
}
