import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { root, releasePlan } from "./manifest.mjs";
import { copyAtomic, readJson, sha256, writeJsonAtomic } from "../lib/artifacts.mjs";
import { ensureCheckout } from "../lib/source-checkout.mjs";
import { prepareCodexBuildSource } from "../lib/codex-lock.mjs";
import { run } from "../lib/process.mjs";
import { verifyCodex } from "../verify-codex-runtime.mjs";

// Linux packages contain Codex's LGPL bubblewrap helper. Distribute the exact
// compiled source tree (including its wrapper, manifests and normalized lock),
// not only a link to a moving upstream branch. No binaries or Git metadata.
export async function collectCodexSource() {
  const plan = await releasePlan();
  await verifyCodex({ root });
  const manifest = await readJson(join(root, "runtimes/codex/source.json"));
  const source = await ensureCheckout({ root, directory: join(root, ".cache/codex-source", manifest.commit),
    repository: manifest.repository, commit: manifest.commit, verifyOnly: true });
  const { cargoRoot, lockNormalized } = await prepareCodexBuildSource({ root, source, commit: manifest.commit, toolchain: manifest.rustToolchain });
  const compiled = dirname(cargoRoot);
  await mkdir(join(root, ".work"), { recursive: true });
  await mkdir(join(root, "release"), { recursive: true });
  const stage = await mkdtemp(join(root, ".work/release-codex-source-"));
  const file = `Agent-Lab-${plan.version}-codex-component-source.tar.gz`;
  try {
    for (const path of ["scripts/build-codex-runtime.mjs", "scripts/verify-codex-runtime.mjs", "scripts/doctor.mjs",
      "scripts/lib/codex-lock.mjs", "scripts/lib/source-checkout.mjs", "scripts/lib/artifacts.mjs", "scripts/lib/process.mjs",
      "scripts/lib/docker.mjs", "runtimes/platform.mjs", "runtimes/codex/source.json", "README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"])
      await copyAtomic(join(root, path), join(stage, "agent-lab-build", path));
    await writeJsonAtomic(join(stage, "codex-component-source.json"), { schemaVersion: 1, version: plan.version,
      commit: plan.commit, upstreamCommit: manifest.commit, upstreamRepository: manifest.repository,
      rustToolchain: manifest.rustToolchain, lockNormalized, sourceDirectory: basename(compiled),
      buildInstructions: `Use the Agent Lab source at https://github.com/${plan.repository}/tree/${plan.commit} and its README Codex source-build instructions. The source tree in this archive is the exact compiled checkout; Cargo.lock has only local workspace versions normalized by the included codex-lock.mjs.` });
    await run("tar", ["--exclude=.git", "-czf", join(stage, file), "-C", dirname(compiled), basename(compiled),
      "-C", stage, "agent-lab-build", "codex-component-source.json"], { timeout: 300_000 });
    await copyAtomic(join(stage, file), join(root, "release", file));
    await writeJsonAtomic(join(root, "release/codex-component-source.json"), { schemaVersion: 1, version: plan.version,
      commit: plan.commit, upstreamCommit: manifest.commit, file, sha256: await sha256(join(root, "release", file)) });
  } finally { await rm(stage, { recursive: true, force: true }); }
  console.log("Codex / bubblewrap 对应源码与构建说明已准备；不包含二进制、用户数据或 Git 元数据。");
}

export async function verifyCodexSource(plan, directory) {
  const manifest = await readJson(join(root, "runtimes/codex/source.json"));
  const receipt = await readJson(join(directory, "codex-component-source.json"));
  const file = `Agent-Lab-${plan.version}-codex-component-source.tar.gz`;
  if (receipt.schemaVersion !== 1 || receipt.version !== plan.version || receipt.commit !== plan.commit
    || receipt.upstreamCommit !== manifest.commit || receipt.file !== file || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || !(await stat(join(directory, file))).isFile() || await sha256(join(directory, file)) !== receipt.sha256)
    throw new Error("Codex / bubblewrap 对应源码的版本或文件校验不匹配，未发布 Linux 安装包");
  return { file, sha256: receipt.sha256, upstreamCommit: receipt.upstreamCommit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectCodexSource().catch(error => { console.error(error.message); process.exitCode = 1; });
}
