import { appendFile, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releasePlan, root } from "./manifest.mjs";
import { readJson, sha256 } from "../lib/artifacts.mjs";
import { run } from "../lib/process.mjs";
import { verifyReleaseAssetSize } from "./assets.mjs";

async function githubJson(plan, path) {
  try { return JSON.parse(await run("gh", ["api", `repos/${plan.repository}/${path}`], { capture: true })); }
  catch (error) { if (String(error).includes("HTTP 404")) return null; throw error; }
}
async function checkVersion(plan) {
  const existing = await githubJson(plan, `releases/tags/${plan.tag}`);
  if (existing && !existing.draft) throw new Error("此版本已公开发布；不能覆盖安装包或镜像，请先增加版本号");
  const ref = await githubJson(plan, `git/ref/tags/${plan.tag}`);
  if (ref) {
    let object = ref.object;
    if (object.type === "tag") object = (await githubJson(plan, `git/tags/${object.sha}`))?.object;
    if (object?.type !== "commit" || object.sha !== plan.commit) throw new Error("同名 tag 已指向其他源码；不能覆盖，请使用新版本");
  }
  return existing;
}
export async function preflight(plan) {
  await checkVersion(plan);
  if (await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, capture: true })) throw new Error("发版必须来自已提交的干净源码，不能包含未提交修改");
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `commit=${plan.commit}\nversion=${plan.version}\ntag=${plan.tag}\ndesktop=${JSON.stringify({ include: plan.desktop })}\n`);
  console.log(`发布前置检查通过 · ${plan.tag} · ${plan.commit} · ${plan.desktop.map(target => target.id).join(", ")}`);
}
export async function publishRelease(plan, directory, publish = false) {
  const existing = await checkVersion(plan);
  const manifest = await readJson(join(directory, "release-manifest.json"));
  if (manifest.commit !== plan.commit || manifest.version !== plan.version || manifest.repository !== plan.repository) throw new Error("附件清单不是当前发版源码");
  const sums = (await readFile(join(directory, "SHA256SUMS.txt"), "utf8")).trim().split("\n");
  const names = [];
  for (const line of sums) {
    const match = line.match(/^([a-f0-9]{64})  ([a-zA-Z0-9_.-]+)$/);
    if (!match || names.includes(match[2])) throw new Error("发布附件校验表无效");
    await verifyReleaseAssetSize(join(directory, match[2]));
    if (await sha256(join(directory, match[2])) !== match[1]) throw new Error(`附件 SHA-256 不匹配：${match[2]}`);
    names.push(match[2]);
  }
  names.push("SHA256SUMS.txt");
  const actual = (await readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) throw new Error("发布目录存在校验表以外的文件，拒绝上传");
  const paths = names.map(name => join(directory, name));
  if (existing) {
    const unexpected = existing.assets?.filter(asset => !names.includes(asset.name)) ?? [];
    if (unexpected.length) throw new Error("草稿中有非本流程管理的附件，未删除或覆盖，请先核对");
    await run("gh", ["release", "upload", plan.tag, "--repo", plan.repository, "--clobber", ...paths], { timeout: 1_800_000 });
    await run("gh", ["release", "edit", plan.tag, "--repo", plan.repository, "--notes-file", join(directory, "RELEASE.md"), "--prerelease"]);
  } else {
    await run("gh", ["release", "create", plan.tag, "--repo", plan.repository, "--target", plan.commit, "--title", `Agent Lab ${plan.version}`,
      "--notes-file", join(directory, "RELEASE.md"), "--draft", "--prerelease", ...paths], { timeout: 1_800_000 });
  }
  if (publish) await run("gh", ["release", "edit", plan.tag, "--repo", plan.repository, "--draft=false", "--prerelease", "--latest=false"]);
  console.log(`${publish ? "已公开发布" : "已创建发版草稿"} · https://github.com/${plan.repository}/releases/tag/${plan.tag}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  releasePlan({ version: value("--version"), repository: value("--repository"), targets: value("--targets") })
    .then(plan => args.includes("--preflight") ? preflight(plan) : publishRelease(plan, resolve(value("--directory") ?? join(root, ".work/release-publish")), args.includes("--publish")))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
