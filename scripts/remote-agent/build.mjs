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

export function deploymentArguments(definition, source, directory) {
  if (!definition.deployment) return undefined;
  if (definition.deployment.dockerfile !== "deployment.Dockerfile" || !/^selfme-lab\/[a-z0-9-]+:[a-zA-Z0-9_.-]+$/.test(definition.deployment.image)) throw new Error("部署层构建定义无效");
  return ["build", "--progress=plain", "--build-context", `document-preview=${join(projectRoot, "services/remote-agent/document-preview")}`, ...(definition.id === "openclaw" ? ["--build-context", `model-discovery=${join(projectRoot, "packages/remote-agent/src")}`] : []), "--file", join(directory, "deployment.Dockerfile"),
    "--tag", definition.deployment.image, "--build-arg", `SOURCE_IMAGE=${definition.build.image}`,
    "--label", `ai.selfme.lab.engine=${definition.id}`, "--label", `ai.selfme.lab.source.commit=${source.commit}`,
    "--label", "ai.selfme.lab.integration=1", directory];
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
  const deployment = deploymentArguments(definition, source, join(projectRoot, "services", "remote-agent", engine));
  await access(build[build.indexOf("--file") + 1]);
  if (deployment) await access(deployment[deployment.indexOf("--file") + 1]);
  if (args.includes("--plan")) { console.log(JSON.stringify({ engine, commit: source.commit, commands: [build, ...(deployment ? [deployment] : [])].map(args => ({ command: "docker", args })) }, null, 2)); return; }
  await run("docker", ["info", "--format", "{{.ServerVersion}}"], projectRoot, { capture: true, timeout: 15_000 });
  const preview = JSON.parse(await readFile(join(projectRoot, "services/remote-agent/document-preview/service.json"), "utf8"));
  await run("docker", ["pull", "--quiet", preview.image], projectRoot, { timeout: 600_000 });
  await run("docker", build, projectRoot, { timeout: 3_600_000 });
  if (deployment) await run("docker", deployment, projectRoot, { timeout: 600_000 });
  const actual = await run("docker", ["image", "inspect", "--format", '{{index .Config.Labels "ai.selfme.lab.source.commit"}}', definition.build.image], projectRoot, { capture: true });
  if (actual !== source.commit) throw new Error("构建镜像的源码标识校验失败");
  if (deployment) {
    const integration = await run("docker", ["image", "inspect", "--format", '{{index .Config.Labels "ai.selfme.lab.source.commit"}}|{{index .Config.Labels "ai.selfme.lab.integration"}}', definition.deployment.image], projectRoot, { capture: true });
    if (integration !== `${source.commit}|1`) throw new Error("部署层镜像标识校验失败");
  }
  console.log(`固定源码镜像构建完成：${definition.deployment?.image ?? definition.build.image}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildMain(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
