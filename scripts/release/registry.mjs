import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { architectureTag, digestReference, imageTargets } from "./manifest.mjs";
import { run } from "../lib/process.mjs";
import { requireDocker } from "../lib/docker.mjs";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const versionPattern = /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/;
const buildPattern = /^build-(?:[a-f0-9]{40}|v\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?-[a-f0-9]{12,40})-(?:amd64|arm64)$/;
const sourceUrl = repository => `https://github.com/${repository}`;
async function github(path, { method = "GET", pages = false } = {}) {
  const output = await run("gh", ["api", "--method", method, ...(pages ? ["--paginate", "--slurp"] : []), path], { capture: true, maxBuffer: 8_000_000 });
  return output ? JSON.parse(output) : null;
}
function validateVersion(item) {
  if (!Number.isSafeInteger(item.id) || item.id <= 0 || !digestPattern.test(item.name) || item.metadata?.package_type !== "container"
    || !Array.isArray(item.metadata.container?.tags) || item.metadata.container.tags.some(tag => typeof tag !== "string"))
    throw new Error("GHCR 镜像版本记录无效，未清理");
  return item.metadata.container.tags;
}
export function cleanupCandidates(versions, protectedDigests) {
  return versions.filter(item => {
    const tags = validateVersion(item);
    return !protectedDigests.has(item.name) && tags.every(tag => buildPattern.test(tag));
  });
}
// Preserve every non-build tag, not just the newest release. Walk the complete
// index graph: an untagged child/attestation may still be required by a release.
export async function protectedImageDigests(versions, readManifest, pinned = []) {
  const protectedDigests = new Set();
  async function visit(digest) {
    if (!digestPattern.test(digest)) throw new Error("镜像引用 digest 无效");
    if (protectedDigests.has(digest)) return;
    if (protectedDigests.size >= 10_000) throw new Error("镜像引用过多，停止自动清理");
    protectedDigests.add(digest);
    const manifest = await readManifest(digest);
    if (manifest.manifests !== undefined) {
      if (!Array.isArray(manifest.manifests)) throw new Error("镜像索引无效");
      for (const child of manifest.manifests) await visit(child.digest);
    } else if (!digestPattern.test(manifest.config?.digest) || !Array.isArray(manifest.layers)) throw new Error("镜像清单无效");
  }
  for (const digest of pinned) await visit(digest);
  for (const item of versions) if (validateVersion(item).some(tag => !buildPattern.test(tag))) await visit(item.name);
  return protectedDigests;
}
function registryReader(repository) {
  digestReference(repository, `sha256:${"0".repeat(64)}`);
  const path = repository.slice("ghcr.io/".length);
  let token;
  return async (reference, { blob = false, optional = false } = {}) => {
    if (!digestPattern.test(reference) && !versionPattern.test(reference.replace(/-(?:amd64|arm64)$/, ""))) throw new Error("Registry 引用无效");
    if (!token) {
      const response = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${path}:pull`)}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("镜像无法匿名读取，未修改 Registry");
      token = (await response.json()).token;
      if (typeof token !== "string" || !token) throw new Error("未获得匿名 Registry 令牌");
    }
    const response = await fetch(`https://ghcr.io/v2/${path}/${blob ? "blobs" : "manifests"}/${reference}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`Registry 读取失败（${response.status}），未继续修改`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if ((digestPattern.test(reference) && actual !== reference) || (!blob && response.headers.get("docker-content-digest") !== actual))
      throw new Error("Registry 内容摘要校验失败");
    return { digest: actual, value: JSON.parse(bytes.toString("utf8")) };
  };
}
async function publishedManifest(repository, release) {
  const asset = release.assets?.find(item => item.name === "release-manifest.json");
  const prefix = `https://github.com/${repository}/releases/download/${release.tag_name}/`;
  if (!versionPattern.test(release.tag_name) || !asset?.browser_download_url?.startsWith(prefix) || !digestPattern.test(asset.digest)
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1_000_000) throw new Error("已发布版本缺少可信镜像清单，未清理");
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("无法读取已发布镜像清单");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.digest) throw new Error("发布清单摘要不匹配");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.repository !== repository || manifest.tag !== release.tag_name || `v${manifest.version}` !== release.tag_name
    || !/^[a-f0-9]{40}$/.test(manifest.commit)) throw new Error("发布清单身份不匹配");
  for (const engine of ["openhands", "openclaw"]) {
    const image = manifest.images?.[engine];
    if (image?.repository !== `ghcr.io/${repository.toLowerCase()}-${engine}`) throw new Error("发布清单镜像仓库不匹配");
    digestReference(image.repository, image.digest);
  }
  return manifest;
}
export function aliasTargets(manifest, engine, index) {
  const image = manifest.images[engine];
  if (!Array.isArray(index.manifests) || index.manifests.length !== imageTargets.length) throw new Error("正式镜像缺少完整双架构清单");
  return imageTargets.map(target => {
    const matches = index.manifests.filter(item => item.platform?.os === "linux" && item.platform.architecture === target.arch);
    if (matches.length !== 1) throw new Error("正式镜像架构记录不唯一");
    digestReference(image.repository, matches[0].digest);
    return { tag: `${image.repository}:${architectureTag(manifest, target.arch)}`, digest: matches[0].digest };
  });
}
async function retagRelease(repository, version) {
  if (!versionPattern.test(version)) throw new Error("需要正式版本标签，如 v0.1.0");
  const release = await github(`repos/${repository}/releases/tags/${version}`);
  if (release.draft) throw new Error("只为已公开版本补标签，不重新发布草稿");
  const manifest = await publishedManifest(repository, release);
  const copies = [];
  // Validate both services and every destination before the first write.
  for (const engine of ["openhands", "openclaw"]) {
    const image = manifest.images[engine], reader = registryReader(image.repository);
    const index = (await reader(image.digest)).value;
    if ((await reader(version)).digest !== image.digest) throw new Error("正式版本入口已偏离发布清单，拒绝覆盖");
    for (const alias of aliasTargets(manifest, engine, index)) {
      const child = (await reader(alias.digest)).value;
      if (child.manifests || !digestPattern.test(child.config?.digest) || !Array.isArray(child.layers)) throw new Error("架构镜像不是原始单架构清单");
      const existing = await reader(alias.tag.split(":").at(-1), { optional: true });
      if (existing && existing.digest !== alias.digest) throw new Error("版本架构标签已有不同内容，拒绝覆盖");
      if (!existing) copies.push({ ...alias, repository: image.repository, reader });
    }
    // Refresh only the exact existing index, so the package's default entry is
    // the multi-platform release rather than the last architecture alias.
    copies.push({ tag: `${image.repository}:${version}`, digest: image.digest, repository: image.repository, reader });
  }
  const { executable: docker } = await requireDocker();
  for (const item of copies) {
    await run(docker, ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", item.tag, digestReference(item.repository, item.digest)]);
    if ((await item.reader(item.tag.split(":").at(-1))).digest !== item.digest) throw new Error("补标签后 digest 变化，停止清理");
    console.log(`标签已验证 · ${item.tag} · ${item.digest}`);
  }
  console.log("已发布镜像摘要、Release 附件和下载脚本均未改变。原 build 标签作为同一 digest 的兼容别名保留，不能通过删除整个版本移除它。");
}
async function cleanupPackages(repository, apply) {
  const repo = await github(`repos/${repository}`);
  if (repo.full_name !== repository || !["User", "Organization"].includes(repo.owner?.type)) throw new Error("仓库身份无效");
  const prefix = `${repo.owner.type === "User" ? "users" : "orgs"}/${repo.owner.login}`;
  const releases = (await github(`repos/${repository}/releases?per_page=100`, { pages: true })).flat();
  const manifests = await Promise.all(releases.filter(release => !release.draft).map(release => publishedManifest(repository, release)));
  const plans = [];
  for (const engine of ["openhands", "openclaw"]) {
    const packageName = `${repository.split("/")[1]}-${engine}`.toLowerCase();
    const endpoint = `${prefix}/packages/container/${packageName}`;
    const pkg = await github(endpoint);
    if (pkg.name !== packageName || pkg.package_type !== "container" || pkg.repository?.full_name !== repository) throw new Error("容器包不属于当前仓库，未清理");
    const reader = registryReader(`ghcr.io/${repository.toLowerCase()}-${engine}`);
    const versions = (await github(`${endpoint}/versions?per_page=100&state=active`, { pages: true })).flat();
    const pinned = manifests.map(manifest => manifest.images[engine].digest);
    const protectedDigests = await protectedImageDigests(versions, async digest => (await reader(digest)).value, pinned);
    const candidates = [];
    for (const item of cleanupCandidates(versions, protectedDigests)) {
      const image = (await reader(item.name)).value;
      let owned;
      if (image.manifests) owned = image.annotations?.["org.opencontainers.image.source"] === sourceUrl(repository);
      else {
        const config = (await reader(image.config.digest, { blob: true })).value;
        const labels = config.config?.Labels ?? {};
        owned = labels["org.opencontainers.image.source"] === sourceUrl(repository) && labels["ai.agent-lab.desktop.engine"] === engine
          && /^[a-f0-9]{40}$/.test(labels["org.opencontainers.image.revision"] ?? "");
      }
      if (owned) candidates.push(item);
    }
    plans.push({ endpoint, packageName, reader, pinned, candidates });
  }
  for (const plan of plans) {
    for (const item of plan.candidates) {
      // Re-read tags AND their entire reference graph immediately before a
      // deletion. The shared workflow concurrency also excludes release jobs.
      const current = (await github(`${plan.endpoint}/versions?per_page=100&state=active`, { pages: true })).flat();
      const protectedNow = await protectedImageDigests(current, async digest => (await plan.reader(digest)).value, plan.pinned);
      const found = cleanupCandidates(current, protectedNow).find(version => version.id === item.id && version.name === item.name);
      if (!found) { console.log(`已跳过新的引用或标签 · ${plan.packageName} · ${item.id}`); continue; }
      console.log(`${apply ? "删除" : "预览删除"} · ${plan.packageName} · ${item.id} · ${item.name} · ${validateVersion(found).join(", ") || "untagged"}`);
      if (apply) await github(`${plan.endpoint}/versions/${item.id}`, { method: "DELETE" });
    }
    const remaining = (await github(`${plan.endpoint}/versions?per_page=100&state=active`, { pages: true })).flat();
    await protectedImageDigests(remaining, async digest => (await plan.reader(digest)).value, plan.pinned);
    console.log(`${plan.packageName} · ${remaining.length} 个活动镜像版本 · 已验证所有保留引用`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  const repository = args.includes("--repository") ? value("--repository") : "SelfMeAI/agent-lab";
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new Error("仓库名称无效");
  (async () => {
    if (!args.includes("--retag") && !args.includes("--cleanup")) throw new Error("需要 --retag 或 --cleanup；清理默认仅预览，--apply 才删除");
    if (args.includes("--retag")) await retagRelease(repository, value("--version"));
    if (args.includes("--cleanup")) await cleanupPackages(repository, args.includes("--apply"));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
