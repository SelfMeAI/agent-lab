import { access, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureSource, projectRoot, readLock, run } from "./source.mjs";

export function buildArguments(definition, source, directory) {
  if (definition.schemaVersion !== 1 || definition.build?.source !== source.id || !/^selfme-lab\/[a-z0-9-]+:[a-zA-Z0-9_.-]+$/.test(definition.build.image ?? "")) throw new Error("服务构建定义无效");
  const dockerfile = resolve(directory, definition.build.dockerfile ?? "");
  if (!dockerfile.startsWith(`${resolve(directory)}${sep}`)) throw new Error("Dockerfile 必须位于固定源码目录内");
  const args = ["build", "--progress=plain", "--file", dockerfile, "--tag", definition.build.image,
    "--label", `ai.selfme.lab.engine=${definition.id}`, "--label", `ai.selfme.lab.source.commit=${source.commit}`];
  if (definition.build.target) args.push("--target", definition.build.target);
  for (const [key, value] of Object.entries(definition.build.args ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string") throw new Error("镜像构建参数无效");
    args.push("--build-arg", `${key}=${value}`);
  }
  args.push(directory);
  return args;
}

export async function buildMain(args) {
  if (args.includes("--help")) { console.log("npm run remote:build -- <openhands|openclaw> [--plan]"); return; }
  const engine = args[0];
  const lock = await readLock(engine);
  const definition = JSON.parse(await readFile(join(projectRoot, "services", "remote-agent", engine, "service.json"), "utf8"));
  if (definition.id !== engine) throw new Error("服务标识不匹配");
  const source = lock.sources.find(item => item.id === definition.build?.source);
  if (!source) throw new Error("构建使用的源码不在锁文件中");
  const directory = await ensureSource(engine, source);
  const build = buildArguments(definition, source, directory);
  await access(build[build.indexOf("--file") + 1]);
  if (args.includes("--plan")) { console.log(JSON.stringify({ engine, commit: source.commit, command: "docker", args: build }, null, 2)); return; }
  await run("docker", ["info", "--format", "{{.ServerVersion}}"], projectRoot, { capture: true, timeout: 15_000 });
  await run("docker", build, projectRoot, { timeout: 3_600_000 });
  const actual = await run("docker", ["image", "inspect", "--format", '{{index .Config.Labels "ai.selfme.lab.source.commit"}}', definition.build.image], projectRoot, { capture: true });
  if (actual !== source.commit) throw new Error("构建镜像的源码标识校验失败");
  console.log(`固定源码镜像构建完成：${definition.build.image}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildMain(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
