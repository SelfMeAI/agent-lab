import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { architectureTag, digestReference, imageTargets, root } from "./manifest.mjs";
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
    if (!digestPattern.test(reference) && !buildPattern.test(reference) && !/^unlink-check-[a-f0-9]{32}-keep$/.test(reference)
      && !versionPattern.test(reference.replace(/-(?:amd64|arm64)$/, ""))) throw new Error("Registry 引用无效");
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
  console.log("已发布镜像摘要、Release 附件和下载脚本均未改变。");
}
export function unlinkDeletionTarget(versions, tag, temporaryDigest, protectedDigests) {
  const matches = versions.filter(item => item.name === temporaryDigest);
  if (matches.length !== 1 || protectedDigests.has(temporaryDigest)) throw new Error("临时镜像仍被引用或记录不唯一，拒绝删除");
  const tags = validateVersion(matches[0]);
  if (tags.length !== 1 || tags[0] !== tag) throw new Error("临时镜像还有其他标签，拒绝删除");
  return matches[0];
}
export function isUnlinkPlaceholder(config, repository, nonce = config.config?.Labels?.["ai.agent-lab.unlink.nonce"]) {
  const labels = config.config?.Labels ?? {};
  return /^[a-f0-9]{32}$/.test(nonce ?? "") && labels["org.opencontainers.image.source"] === sourceUrl(repository)
    && labels["ai.agent-lab.maintenance"] === "tag-unlink" && labels["ai.agent-lab.unlink.nonce"] === nonce
    && config.rootfs?.type === "layers" && Array.isArray(config.rootfs.diff_ids) && config.rootfs.diff_ids.length === 0;
}
// The normal GHCR DELETE endpoint deletes a whole manifest, not just its tag.
// Move only the explicitly selected old name to an owned, empty manifest first.
// The original manifest is never deleted and all release aliases remain pinned.
async function removeLegacyAliases(repository, version, apply) {
  if (!versionPattern.test(version)) throw new Error("需要已发布版本标签");
  const release = await github(`repos/${repository}/releases/tags/${version}`);
  if (release.draft) throw new Error("只清理已公开版本的历史标签");
  const manifest = await publishedManifest(repository, release);
  const repo = await github(`repos/${repository}`);
  if (repo.full_name !== repository || !["User", "Organization"].includes(repo.owner?.type)) throw new Error("仓库身份无效");
  const prefix = `${repo.owner.type === "User" ? "users" : "orgs"}/${repo.owner.login}`;
  const releases = (await github(`repos/${repository}/releases?per_page=100`, { pages: true })).flat();
  const published = await Promise.all(releases.filter(item => !item.draft).map(item => publishedManifest(repository, item)));
  const plans = [];
  for (const engine of ["openhands", "openclaw"]) {
    const image = manifest.images[engine], reader = registryReader(image.repository);
    const endpoint = `${prefix}/packages/container/${repository.split("/")[1].toLowerCase()}-${engine}`;
    const pkg = await github(endpoint);
    if (pkg.repository?.full_name !== repository || pkg.package_type !== "container") throw new Error("容器包不属于当前仓库");
    const index = (await reader(image.digest)).value;
    const aliases = [{tag:`${image.repository}:${version}`,digest:image.digest},...aliasTargets(manifest,engine,index)];
    for (const alias of aliases) if ((await reader(alias.tag.split(":").at(-1))).digest !== alias.digest) throw new Error("正式标签不匹配，拒绝解绑");
    const removals = [];
    for (const target of imageTargets) {
      const tag = `build-${manifest.commit}-${target.arch}`;
      const current = await reader(tag,{optional:true});
      if (!current) continue;
      const original = aliases.find(alias => alias.tag.endsWith(`-${target.arch}`)).digest;
      if (current.digest !== original) throw new Error("旧标签已指向其他内容，未作修改");
      removals.push({tag,original});
    }
    plans.push({engine,image,reader,endpoint,aliases,removals,pinned:published.map(item=>item.images[engine].digest)});
  }
  if (!apply) {
    for (const plan of plans) for (const item of plan.removals) console.log(`预览解绑 · ${plan.image.repository}:${item.tag} · 保留 ${item.original}`);
    return;
  }
  if (!plans.some(plan=>plan.removals.length)) { console.log("没有遗留标签需要解绑。"); return; }
  const {executable:docker} = await requireDocker();
  const checkAliases = async plan => {
    for (const alias of plan.aliases) if ((await plan.reader(alias.tag.split(":").at(-1))).digest !== alias.digest) throw new Error("正式版本验证失败，停止清理");
  };
  const placeholder = async (plan,tag,nonce = randomUUID().replaceAll("-","")) => {
    const local = `agent-lab/tag-unlink:${nonce}`;
    let built = false;
    try {
      await run(docker,["buildx","build","--load","--provenance=false","--network=none","--file",join(root,"scripts/release/unlink.Dockerfile"),
        "--build-arg",`REPOSITORY=${sourceUrl(repository)}`,"--build-arg",`UNLINK_NONCE=${nonce}`,"--tag",local,join(root,"scripts/release")]);
      built = true;
      const destination = `${plan.image.repository}:${tag}`;
      await run(docker,["tag",local,destination]);
      await run(docker,["push",destination]);
      const temporary = await plan.reader(tag);
      if (temporary.value.manifests || temporary.value.layers?.length !== 0) throw new Error("占位镜像必须是无层的独立清单");
      const config = (await plan.reader(temporary.value.config.digest,{blob:true})).value;
      if (!isUnlinkPlaceholder(config,repository,nonce)) throw new Error("临时镜像归属不匹配");
      return temporary.digest;
    } finally { if (built) await run(docker,["image","rm",local]); }
  };
  const eraseTemporary = async (plan,tag,temporaryDigest) => {
    const versions = (await github(`${plan.endpoint}/versions?per_page=100&state=active`,{pages:true})).flat();
    // Exclude only this one intentionally removed tag when walking roots.
    // Any other tag or index referencing the placeholder still vetoes deletion.
    const withoutTarget = versions.map(item=>({...item,metadata:{...item.metadata,container:{...item.metadata.container,
      tags:validateVersion(item).filter(name=>!(item.name===temporaryDigest && name===tag))}}}));
    const preserved = await protectedImageDigests(withoutTarget,async value=>(await plan.reader(value)).value,plan.pinned);
    const item = unlinkDeletionTarget(versions,tag,temporaryDigest,preserved);
    await checkAliases(plan);
    console.log(`删除独立临时镜像 · ${plan.engine} · ${item.id} · ${temporaryDigest}`);
    await github(`${plan.endpoint}/versions/${item.id}`,{method:"DELETE"});
    if (await plan.reader(tag,{optional:true})) throw new Error("旧标签仍可读取，清理未完成");
    await checkAliases(plan);
  };
  const unlink = async (plan,tag,original) => {
    if ((await plan.reader(tag)).digest !== original) throw new Error("标签在解绑前已变化");
    const nonce = randomUUID().replaceAll("-","");
    let temporaryDigest;
    try {
      temporaryDigest = await placeholder(plan,tag,nonce);
      await eraseTemporary(plan,tag,temporaryDigest);
      await plan.reader(original);
    } catch (error) {
      // If unlink failed, restore only our moved tag, never another writer's tag.
      const current = await plan.reader(tag,{optional:true});
      const config = current && !current.value.manifests ? (await plan.reader(current.value.config.digest,{blob:true})).value : null;
      if (current && config && isUnlinkPlaceholder(config,repository,nonce))
        await run(docker,["buildx","imagetools","create","--prefer-index=false","--tag",`${plan.image.repository}:${tag}`,digestReference(plan.image.repository,original)]);
      throw error;
    }
  };
  // Live canary: two disposable names share one empty manifest. Removing one
  // must not remove the other's digest. Both test manifests are then deleted.
  const canary = plans[0], nonce = randomUUID().replaceAll("-","");
  const keep = `unlink-check-${nonce}-keep`, remove = `build-${createHash("sha256").update(nonce).digest("hex").slice(0,40)}-amd64`;
  const original = await placeholder(canary,keep);
  await run(docker,["buildx","imagetools","create","--prefer-index=false","--tag",`${canary.image.repository}:${remove}`,digestReference(canary.image.repository,original)]);
  await unlink(canary,remove,original);
  if ((await canary.reader(keep)).digest!==original) throw new Error("验证失败：另一标签受到影响");
  await eraseTemporary(canary,keep,original);
  console.log("临时标签验证通过 · 单独删除标签不影响另一标签及原镜像 · 测试产物已清理。");
  for (const plan of plans) for (const item of plan.removals) {
    await unlink(plan,item.tag,item.original);
    console.log(`旧别名已移除 · ${plan.image.repository}:${item.tag}`);
  }
  for (const plan of plans) {
    await checkAliases(plan);
    await run(docker,["buildx","imagetools","create","--prefer-index=false","--tag",`${plan.image.repository}:${version}`,digestReference(plan.image.repository,plan.image.digest)]);
    await checkAliases(plan);
  }
  console.log("遗留别名已移除；正式镜像和发布附件保持不变。");
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
        owned = isUnlinkPlaceholder(config,repository) || (labels["org.opencontainers.image.source"] === sourceUrl(repository) && labels["ai.agent-lab.desktop.engine"] === engine
          && /^[a-f0-9]{40}$/.test(labels["org.opencontainers.image.revision"] ?? ""));
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
    if (!args.includes("--retag") && !args.includes("--cleanup") && !args.includes("--remove-legacy")) throw new Error("需要 --retag、--cleanup 或 --remove-legacy；清理默认仅预览，--apply 才删除");
    if (args.includes("--retag")) await retagRelease(repository, value("--version"));
    if (args.includes("--remove-legacy")) await removeLegacyAliases(repository,value("--version"),args.includes("--apply"));
    if (args.includes("--cleanup")) await cleanupPackages(repository, args.includes("--apply"));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
