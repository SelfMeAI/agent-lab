import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export function npmInvocation(args, env = process.env, node = process.execPath) {
  // A .cmd cannot be spawned safely with shell:false on Windows. Execute npm's
  // JavaScript entry with Node instead; paths and arguments stay separate.
  const candidates = [env.npm_execpath,
    join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(dirname(node)), "lib/node_modules/npm/bin/npm-cli.js")];
  // Node and npm can legitimately come from separate tool installations.
  // Resolve POSIX symlinks / Windows npm launcher's sibling JS entry, without
  // executing a shell script or accepting a relative PATH search directory.
  for (const path of (env.PATH ?? env.Path ?? "").split(delimiter).filter(isAbsolute)) {
    candidates.push(join(path, "node_modules/npm/bin/npm-cli.js"));
    try { candidates.push(realpathSync(join(path, "npm"))); } catch { /* next location */ }
  }
  const entry = candidates.find(path => typeof path === "string" && path.endsWith("npm-cli.js") && existsSync(path));
  if (!entry) throw new Error("未找到 npm 的 JavaScript 入口，请通过 npm run 执行此命令，并安装包含 npm 的 Node.js");
  return { command: env.npm_node_execpath || node, args: [entry, ...args] };
}

export function run(command, args, { cwd, env, capture = false, timeout = 300_000, maxBuffer = 128_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let output = "", timedOut = false;
    if (capture) {
      child.stdout.on("data", data => { output = (output + data.toString()).slice(-maxBuffer); });
      child.stderr.on("data", data => { output = (output + data.toString()).slice(-maxBuffer); });
    }
    const timer = timeout ? setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeout) : undefined;
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} 超时；可修复环境后重试`));
      else if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} 失败（${signal ?? code}）${capture ? `：${output.trim()}` : ""}`));
    });
  });
}

export function runNpm(args, options) {
  const invocation = npmInvocation(args);
  return run(invocation.command, invocation.args, options);
}
