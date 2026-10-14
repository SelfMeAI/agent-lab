import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { releasePlan, root, digestReference, imageTargets, validateImageReceipt, architectureTag } from "./manifest.mjs";
import { readJson, writeJsonAtomic } from "../lib/artifacts.mjs";
import { requireDocker } from "../lib/docker.mjs";
import { run, runNpm } from "../lib/process.mjs";
import { buildMain } from "../remote-agent/build.mjs";

export function verifyImage(image, expected, arch, revision) {
  const labels = image.Config?.Labels ?? {};
  if (image.Os !== "linux" || image.Architecture !== arch || labels["ai.agent-lab.desktop.engine"] !== expected.engine
    || labels["ai.agent-lab.desktop.source.commit"] !== expected.upstreamCommit || labels["ai.agent-lab.desktop.integration"] !== "1"
    || labels["org.opencontainers.image.revision"] !== revision) throw new Error("发布镜像的来源、部署层、源码版本或架构不匹配");
  for (const variable of image.Config?.Env ?? []) {
    const index = variable.indexOf("="), name = variable.slice(0, index), value = variable.slice(index + 1);
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)$/i.test(name) && value.trim()) throw new Error("发布镜像中存在预设凭据，拒绝发布（不输出敏感值）");
  }
}
async function desktopSources(docker, plan) {
  await mkdir(join(root, ".work"), { recursive: true });
  const directory = await mkdtemp(join(root, ".work/release-component-source-"));
  const id = await run(docker, ["create", "--entrypoint", "/bin/true", plan.images.openclaw.localTag], { capture: true });
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("未获得临时源码容器的明确标识");
  try {
    await run(docker, ["cp", `${id}:/opt/agent-lab/desktop/sources`, directory]);
    for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]) await copyFile(join(root, name), join(directory, name));
    await mkdir(join(root, "release"), { recursive: true });
    await run("tar", ["-czf", join(root, "release", `Agent-Lab-${plan.version}-desktop-component-source.tar.gz`), "-C", directory, "sources", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]);
  } finally { await run(docker, ["rm", id]); }
}
async function imageManifest(docker, reference) {
  // Buildx exposes the registry digest in the top-level inspect header. Read
  // that value, never hash a prettified/trimmed copy of a manifest document.
  const result = await run(docker, ["buildx", "imagetools", "inspect", reference], { capture: true });
  const digest = result.match(/^Digest:\s+(sha256:[a-f0-9]{64})\s*$/m)?.[1];
  if (!digest) throw new Error("Registry 未返回镜像清单 digest");
  return digest;
}
export async function mergeImages(plan, directory) {
  const { executable: docker } = await requireDocker();
  const receipts = await Promise.all(imageTargets.map(async target => validateImageReceipt(plan, await readJson(join(directory, `images-linux-${target.arch}.json`)), target.arch)));
  const images = {};
  for (const [engine, definition] of Object.entries(plan.images)) {
    const tag = `${definition.repository}:${plan.tag}`;
    const references = receipts.map(receipt => digestReference(definition.repository, receipt.images[engine].digest));
    await run(docker, ["buildx", "imagetools", "create", "--annotation", `index:org.opencontainers.image.source=https://github.com/${plan.repository}`,
      "--annotation", `index:org.opencontainers.image.description=Agent Lab ${engine} research environment`, "--tag", tag, ...references], { timeout: 600_000 });
    images[engine] = { ...definition, digest: await imageManifest(docker, tag), platforms: imageTargets.map(target => `linux/${target.arch}`) };
  }
  const result = { schemaVersion: 1, version: plan.version, commit: plan.commit, images, documentPreview: plan.documentPreview };
  await writeJsonAtomic(join(directory, "images.json"), result);
  return result;
}
export async function buildImages(plan, publish = false) {
  const { executable: docker } = await requireDocker();
  const server = await run(docker, ["info", "--format", "{{.OSType}}/{{.Architecture}}"], { capture: true });
  const arch = /linux\/(?:aarch64|arm64)$/.test(server) ? "arm64" : /linux\/(?:x86_64|amd64)$/.test(server) ? "amd64" : undefined;
  if (!arch) throw new Error("发版镜像需要 Linux amd64 或 arm64 Docker 服务");
  const labels = { "org.opencontainers.image.source": `https://github.com/${plan.repository}`,
    "org.opencontainers.image.revision": plan.commit, "org.opencontainers.image.version": plan.version };
  for (const [engine, definition] of Object.entries(plan.images)) {
    await buildMain([engine], { labels: { ...labels, "org.opencontainers.image.description": `Agent Lab ${engine} research environment` } });
    const [image] = JSON.parse(await run(docker, ["image", "inspect", definition.localTag], { capture: true }));
    verifyImage(image, { ...definition, engine }, arch, plan.commit);
    const binary = engine === "openclaw" ? "node" : "/agent-server/.venv/bin/python";
    const code = engine === "openclaw"
      ? "const fs=require('node:fs');for(const p of ['/opt/agent-lab/plugin','/opt/agent-lab/licenses/LICENSE','/opt/agent-lab/desktop/sources/xfce4-panel-4.18.2-agent-lab.tar.bz2'])if(!fs.existsSync(p))process.exit(1);if(fs.existsSync('/home/node/.openclaw/openclaw.json'))process.exit(2)"
      : "import pathlib; assert pathlib.Path('/opt/agent-lab/app.py').is_file(); assert pathlib.Path('/opt/agent-lab/licenses/LICENSE').is_file(); assert not any(p.is_file() or p.is_symlink() for p in pathlib.Path('/workspace').rglob('*'))";
    await run(docker, ["run", "--rm", "--network", "none", "--entrypoint", binary, definition.localTag, engine === "openclaw" ? "-e" : "-c", code]);
  }
  // Fresh identities and container-local mock providers; no personal API keys.
  // Run sequentially: do not multiply full browser/desktop containers on an
  // 8 GB Docker host. Each suite owns and cleans its own disposable identity.
  for (const [test, flag] of [
    ["service-manager", "AGENT_LAB_REMOTE_INTEGRATION"],
    ["remote-inputs", "AGENT_LAB_REMOTE_INPUT_INTEGRATION"],
    ["document-preview", "AGENT_LAB_DOCUMENT_PREVIEW_INTEGRATION"],
  ]) await runNpm(["run", "test", "--workspace", "@agent-lab/desktop", "--", `apps/desktop/src/main/remote-agent/${test}.integration.test.ts`],
    { cwd: root, env: { [flag]: "1" }, timeout: 1_200_000 });
  if (arch === "arm64") await desktopSources(docker, plan);
  if (!publish) { console.log(`远端镜像 ${arch} 构建与原生集成验收通过；未上传 Registry。`); return; }
  const images = {};
  for (const [engine, definition] of Object.entries(plan.images)) {
    // Publish only after this architecture passes native service acceptance.
    // The complete source revision remains in OCI labels and the receipt.
    const tag = `${definition.repository}:${architectureTag(plan, arch)}`;
    await run(docker, ["tag", definition.localTag, tag]);
    await run(docker, ["push", tag], { timeout: 1_800_000 });
    images[engine] = { ...definition, digest: await imageManifest(docker, tag) };
  }
  await writeJsonAtomic(join(root, "release", `images-linux-${arch}.json`), { schemaVersion: 1, version: plan.version, commit: plan.commit, arch, verified: true, images });
  console.log(`远端镜像 ${arch} 已通过验收并上传；安装准备脚本只引用固定 digest。`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  releasePlan({ version: value("--version"), repository: value("--repository"), targets: value("--targets") })
    .then(plan => args.includes("--merge") ? mergeImages(plan, value("--directory")) : buildImages(plan, args.includes("--push")))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
