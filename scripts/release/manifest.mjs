import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJson } from "../lib/artifacts.mjs";
import { run } from "../lib/process.mjs";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const desktopTargets = [
  { id: "mac-arm64", os: "macos-15", platform: "mac", arch: "arm64", extensions: ["dmg", "zip"] },
  { id: "mac-x64", os: "macos-15-intel", platform: "mac", arch: "x64", extensions: ["dmg", "zip"] },
  { id: "win-x64", os: "windows-2022", platform: "win", arch: "x64", extensions: ["exe"] },
  { id: "linux-x64", os: "ubuntu-24.04", platform: "linux", arch: "x64", extensions: ["AppImage"] },
];
export const imageTargets = [
  { os: "ubuntu-24.04", arch: "amd64" },
  { os: "ubuntu-24.04-arm", arch: "arm64" },
];
export function architectureTag(plan, arch) {
  if (!/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(plan.tag ?? "") || !imageTargets.some(target => target.arch === arch))
    throw new Error("镜像版本或架构标签无效");
  return `${plan.tag}-${arch}`;
}
export function releaseIdentity({ version, desktopVersion, repository, commit, targets = "all" }) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(version ?? "") || desktopVersion !== version) throw new Error("根目录、桌面应用与发版输入的版本号必须一致");
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? "") || !/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("发布仓库或源码 commit 无效");
  if (targets !== "all" && !desktopTargets.some(target => target.id === targets)) throw new Error("未知桌面发布目标");
  return { schemaVersion: 1, version, tag: `v${version}`, repository, commit,
    desktop: desktopTargets.filter(target => targets === "all" || target.id === targets),
    registry: `ghcr.io/${repository.toLowerCase()}` };
}
export async function releasePlan({ version, repository = "SelfMeAI/agent-lab", targets = "all" } = {}) {
  const pkg = await readJson(join(root, "package.json")), desktop = await readJson(join(root, "apps/desktop/package.json"));
  if (version && version !== pkg.version) throw new Error("发版输入版本与 package.json 不一致，请先单独提交版本变更");
  const commit = await run("git", ["rev-parse", "HEAD"], { cwd: root, capture: true });
  const identity = releaseIdentity({ version: pkg.version, desktopVersion: desktop.version, repository, commit, targets });
  const images = {};
  const deployment = await readFile(join(root, "apps/desktop/src/main/remote-agent/deployment.ts"), "utf8");
  for (const engine of ["openhands", "openclaw"]) {
    const definition = await readJson(join(root, "services/remote-agent", engine, "service.json"));
    const lock = await readJson(join(root, "services/remote-agent", engine, "upstream.lock.json"));
    const source = lock.sources.find(item => item.id === definition.build.source);
    if (!source || !/^[a-f0-9]{40}$/.test(source.commit) || !/^agent-lab\/[a-z0-9-]+:[a-zA-Z0-9_.-]+$/.test(definition.deployment.image)) throw new Error("服务源码锁或本地镜像标签无效");
    if (!deployment.includes(`image: "${definition.deployment.image}"`) || !deployment.includes(`commit: "${source.commit}"`)) throw new Error("客户端与服务构建的固定镜像定义不一致");
    images[engine] = { repository: `${identity.registry}-${engine}`, localTag: definition.deployment.image,
      upstreamCommit: source.commit, upstreamRepository: source.repository, upstreamVersion: source.version };
  }
  const preview = await readJson(join(root, "services/remote-agent/document-preview/service.json"));
  if (!/^gotenberg\/gotenberg:[\w.-]+@sha256:[a-f0-9]{64}$/.test(preview.image)) throw new Error("文档预览镜像必须固定 digest");
  return { ...identity, images, documentPreview: preview.image };
}
export function digestReference(repository, digest) {
  if (!/^ghcr\.io\/[a-z0-9_-]+\/[a-z0-9_.-]+$/.test(repository) || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("镜像必须来自固定 GHCR 仓库和 SHA-256 digest");
  return `${repository}@${digest}`;
}
export function validateImageReceipt(plan, receipt, arch) {
  if (!imageTargets.some(target => target.arch === arch) || receipt.schemaVersion !== 1 || receipt.commit !== plan.commit || receipt.version !== plan.version || receipt.arch !== arch || receipt.verified !== true) throw new Error("镜像验收记录与本次发版不一致");
  for (const [engine, image] of Object.entries(plan.images)) {
    const actual = receipt.images?.[engine];
    if (!actual || actual.localTag !== image.localTag || actual.upstreamCommit !== image.upstreamCommit || actual.repository !== image.repository) throw new Error(`镜像验收记录不匹配：${engine}`);
    digestReference(image.repository, actual.digest);
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  releasePlan({ version: value("--version"), repository: value("--repository"), targets: value("--targets") })
    .then(plan => console.log(JSON.stringify(plan, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
