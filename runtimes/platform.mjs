import { posix, win32 } from "node:path";

const targets = Object.freeze({
  "darwin-arm64": { rustTarget: "aarch64-apple-darwin", dockerPlatform: "linux/arm64" },
  "darwin-x64": { rustTarget: "x86_64-apple-darwin", dockerPlatform: "linux/amd64" },
  "win32-x64": { rustTarget: "x86_64-pc-windows-msvc", dockerPlatform: "linux/amd64" },
  "win32-arm64": { rustTarget: "aarch64-pc-windows-msvc", dockerPlatform: "linux/arm64" },
  "linux-x64": { rustTarget: "x86_64-unknown-linux-gnu", dockerPlatform: "linux/amd64" },
  "linux-arm64": { rustTarget: "aarch64-unknown-linux-gnu", dockerPlatform: "linux/arm64" },
});

export const runtimeTargets = Object.freeze(Object.keys(targets));

export function runtimeTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!Object.hasOwn(targets, key)) throw new Error(`不支持的桌面运行时目标：${key}（仅支持列出的 64 位平台）`);
  return { key, platform, arch, ...targets[key] };
}

export function executableName(name, platform = process.platform) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("可执行文件名称无效");
  return platform === "win32" ? `${name}.exe` : name;
}

// Keep the official Linux archive's bin/lib layout: GPU libraries are resolved
// relative to the executable. macOS and Windows distributions put it at root.
export function ollamaExecutableRelativePath(platform = process.platform) {
  return platform === "linux" ? "native/bin/ollama" : `native/${executableName("ollama", platform)}`;
}

export function codexRuntimeFiles(platform = process.platform) {
  const host = executableName("codex-code-mode-host", platform);
  return [
    `bin/${executableName("codex", platform)}`, `bin/${host}`,
    `codex-resources/${host}`, `codex-path/${executableName("rg", platform)}`,
    ...(platform === "linux" ? ["codex-resources/bwrap"] : []),
    ...(platform === "win32" ? ["codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe"] : []),
  ];
}

export function dockerCliCandidates(platform = process.platform, env = process.env) {
  const paths = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":");
  const pathApi = platform === "win32" ? win32 : posix;
  const searched = paths.filter(path => pathApi.isAbsolute(path)).map(path => pathApi.join(path, executableName("docker", platform)));
  const defaults = platform === "win32"
    ? [win32.join(env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "resources", "bin", "docker.exe")]
    : ["/usr/local/bin/docker", ...(platform === "darwin" ? ["/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"] : ["/usr/bin/docker", "/bin/docker"])];
  return [...new Set([...defaults, ...searched])];
}

export function requireNativeTarget(platform = process.platform, arch = process.arch) {
  const target = runtimeTarget(platform, arch);
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(`请在 ${target.key} 的原生构建机或 CI 上准备运行时；不能把 ${process.platform}-${process.arch} 的二进制打进其他平台的包`);
  }
  return target;
}
