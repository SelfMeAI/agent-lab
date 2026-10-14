import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { releaseIdentity, releasePlan, root, digestReference, validateImageReceipt, desktopTargets } from "./release/manifest.mjs";
import { renderPreparation, verifyDesktopReceipt, verifyPublicImages, releaseNotes } from "./release/assets.mjs";
import { verifyImage } from "./release/images.mjs";

const execute = promisify(execFile);
const commit = "a".repeat(40), digest = `sha256:${"b".repeat(64)}`;
const identity = overrides => releaseIdentity({ version: "0.1.0", desktopVersion: "0.1.0", repository: "SelfMeAI/agent-lab", commit, ...overrides });
const plan = { ...identity({}), images: Object.fromEntries(["openhands", "openclaw"].map(engine => [engine, {
  repository: `ghcr.io/selfmeai/agent-lab-${engine}`, localTag: `agent-lab/${engine}:fixture-v1`, upstreamCommit: "c".repeat(40),
}])), documentPreview: `gotenberg/gotenberg:8.34.0@${digest}` };
const imageList = { version: plan.version, commit, images: Object.fromEntries(Object.entries(plan.images).map(([engine, definition]) => [engine, { ...definition, digest, platforms: ["linux/amd64", "linux/arm64"] }])) };

test("release versions/targets are exact and use only trusted commit/repository/digest forms", () => {
  assert.equal(identity({}).desktop.length, 4); assert.equal(identity({ targets: "mac-arm64" }).desktop.length, 1);
  assert.throws(() => identity({ version: "0.2.0" }), /一致/);
  assert.throws(() => identity({ targets: "mobile" }), /目标/);
  assert.throws(() => identity({ repository: "owner/repo;command" }), /无效/);
  assert.throws(() => identity({ commit: "main" }), /无效/);
  assert.equal(digestReference(plan.images.openclaw.repository, digest), `${plan.images.openclaw.repository}@${digest}`);
  assert.throws(() => digestReference("ghcr.io/private/../repo", digest));
  assert.throws(() => digestReference(plan.images.openclaw.repository, "latest"));
});
test("real release plan agrees with both client image locks and the office preview pin", async () => {
  const actual = await releasePlan(); assert.equal(actual.version, JSON.parse(await readFile(join(root, "package.json"), "utf8")).version);
  assert.match(actual.images.openclaw.localTag, /-lab32$/); assert.match(actual.images.openhands.localTag, /-lab10$/);
  assert.match(actual.documentPreview, /@sha256:[a-f0-9]{64}$/);
});
test("image receipts cannot silently substitute a different source, architecture or local alias", () => {
  const receipt = { schemaVersion: 1, version: plan.version, commit, arch: "arm64", verified: true, images: imageList.images };
  assert.equal(validateImageReceipt(plan, receipt, "arm64"), receipt);
  assert.throws(() => validateImageReceipt(plan, { ...receipt, commit: "d".repeat(40) }, "arm64"));
  assert.throws(() => validateImageReceipt(plan, receipt, "amd64"));
  const altered = structuredClone(receipt); altered.images.openclaw.localTag = "agent-lab/openclaw:other";
  assert.throws(() => validateImageReceipt(plan, altered, "arm64"));
});
test("image metadata checks pinned source, release revision and actual CPU, redacting preset secrets", () => {
  const image = { Os: "linux", Architecture: "arm64", Config: { Env: ["LANG=C.UTF-8"], Labels: {
    "ai.agent-lab.desktop.engine": "openclaw", "ai.agent-lab.desktop.source.commit": plan.images.openclaw.upstreamCommit,
    "ai.agent-lab.desktop.integration": "1", "org.opencontainers.image.revision": commit,
  } } };
  verifyImage(image, { engine: "openclaw", ...plan.images.openclaw }, "arm64", commit);
  assert.throws(() => verifyImage(image, { engine: "openclaw", ...plan.images.openclaw }, "amd64", commit));
  image.Config.Env.push("MODEL_API_KEY=private-fixture-value");
  assert.throws(() => verifyImage(image, { engine: "openclaw", ...plan.images.openclaw }, "arm64", commit), error => /预设凭据/.test(error.message) && !error.message.includes("private-fixture-value"));
});
test("distribution scripts have immutable refs, correct aliases, no runtimes/source prerequisite, and PS5 encoding is handled by the collector", async () => {
  for (const name of ["prepare-remote.sh", "prepare-remote.ps1"]) {
    const value = renderPreparation(await readFile(join(root, "scripts/release", name), "utf8"), plan, imageList);
    assert.doesNotMatch(value, /@[A-Z_]+@/); assert.doesNotMatch(value, /:latest|npm run|git clone/);
    assert.ok(value.includes(`${plan.images.openhands.repository}@${digest}`));
    assert.ok(value.includes(plan.images.openclaw.localTag));
    assert.doesNotMatch(value, /\b(?:prune|volume rm|context use|systemctl)\b/);
  }
  const altered = structuredClone(imageList); altered.images.openclaw.platforms = ["linux/amd64"];
  assert.throws(() => renderPreparation("@VERSION@", plan, altered));
});
test("desktop receipts require real package startup and all native harness checks, not just compilation", () => {
  const target = plan.desktop[0], receipt = { schemaVersion: 1, version: plan.version, commit, target: target.id, verified: true,
    checks: ["packaged-window", "four-labs", "six-bundled-harnesses", "fresh-settings-and-sessions", "native-executables", "bundled-harness-integration"],
    files: target.extensions.map(extension => `Agent-Lab-${plan.version}-${target.id}.${extension}`) };
  assert.deepEqual(verifyDesktopReceipt(plan, target, receipt), receipt.files);
  assert.throws(() => verifyDesktopReceipt(plan, target, { ...receipt, checks: ["compiled"] }));
  assert.throws(() => verifyDesktopReceipt(plan, target, { ...receipt, files: ["../secret.json"] }));
});
test("public image checks do not use user auth and reject private/mismatched/incomplete manifests", async () => {
  const calls = [], token = "anonymous-fixture";
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/token?")) { assert.equal(options.headers, undefined); return new Response(JSON.stringify({ token })); }
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return new Response(JSON.stringify({ manifests: ["amd64", "arm64"].map(architecture => ({ platform: { os: "linux", architecture } })) }), { headers: { "docker-content-digest": digest } });
  };
  await verifyPublicImages(plan, imageList, request); assert.equal(calls.length, 4);
  await assert.rejects(verifyPublicImages(plan, imageList, async () => new Response("", { status: 403 })), /不可匿名下载/);
  await assert.rejects(verifyPublicImages(plan, imageList, async url => url.includes("/token?") ? new Response(JSON.stringify({ token })) : new Response(JSON.stringify({ manifests: [] }), { headers: { "docker-content-digest": digest } })), /缺少/);
});
test("release notes make prerequisites/platform limits and source-free steps explicit", () => {
  const notes = releaseNotes(plan);
  for (const text of ["无需源码", "Docker", "API Key", "模型权重", "prepare-remote.sh", "prepare-remote.ps1", "Pre-release", "未签名", commit.slice(0, 12)]) assert.ok(notes.includes(text), text);
  assert.doesNotMatch(notes, /\$\{plan\./);
});
test("manual publication is separate from push CI and every desktop target has its own native builder", async () => {
  const release = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(release, /workflow_dispatch:/); assert.doesNotMatch(release, /^\s+(?:push|pull_request|release):/m);
  assert.match(release, /--verify-public/); assert.match(release, /needs: \[plan, desktop, images\]/);
  const packages = await readFile(join(root, ".github/workflows/package.yml"), "utf8");
  assert.deepEqual(desktopTargets.map(target => target.os), ["macos-15", "macos-15-intel", "windows-2022", "ubuntu-24.04"]);
  assert.match(packages, /releasePlan/); assert.match(packages, /fromJSON\(needs\.targets\.outputs\.matrix\)/);
  assert.match(packages, /smoke-desktop\.mjs/); assert.doesNotMatch(packages, /packages: write|release create|--publish always/);
});

test("source-free prepare helper checks Docker before pulling, validates before tagging and never touches services", async t => {
  await mkdir(join(root, ".work"), { recursive: true });
  const directory = await mkdtemp(join(root, ".work/release-helper-test-"));
  const bin = join(directory, "bin"), log = join(directory, "calls.jsonl"); await mkdir(bin);
  const fixture = `import {appendFileSync} from 'node:fs';
const a=process.argv.slice(2);appendFileSync(process.env.MOCK_DOCKER_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='info'){if(process.env.MOCK_DOCKER_DOWN)process.exit(4);console.log(process.env.MOCK_DOCKER_PLATFORM??'linux/aarch64');}
if(a[0]==='image'&&a[1]==='inspect'){const engine=a.at(-1).includes('-openhands@')?'openhands':'openclaw';
const labels={'ai.agent-lab.desktop.engine':engine,'ai.agent-lab.desktop.source.commit':'${"c".repeat(40)}','ai.agent-lab.desktop.integration':'1','org.opencontainers.image.revision':process.env.MOCK_IMAGE_BAD?'bad':'${commit}'};
if(a.includes('--format'))console.log(engine+'|'+labels['ai.agent-lab.desktop.source.commit']+'|1|'+labels['org.opencontainers.image.revision']+'|linux/arm64');
else console.log(JSON.stringify([{Os:'linux',Architecture:'arm64',Config:{Labels:labels}}]));}
`;
  await writeFile(join(bin, "fake-docker.mjs"), fixture);
  const windows = process.platform === "win32";
  if (windows) await writeFile(join(bin, "docker.cmd"), `@echo off\r\n"${process.execPath}" "${join(bin, "fake-docker.mjs")}" %*\r\n`);
  else await writeFile(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${join(bin, "fake-docker.mjs").replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  const filename = windows ? "prepare-remote.ps1" : "prepare-remote.sh";
  const rendered = renderPreparation(await readFile(join(root, "scripts/release", filename), "utf8"), plan, imageList);
  await writeFile(join(directory, filename), `${windows ? "\uFEFF" : ""}${rendered}`);
  const args = windows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(directory, filename), "openclaw"] : [join(directory, filename), "openclaw"];
  const command = windows ? "powershell.exe" : "sh";
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, MOCK_DOCKER_LOG: log };
  try {
    await execute(command, args, { env });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls[0][0], "info"); assert.equal(calls.filter(a => a[0] === "tag").length, 1);
    assert.equal(calls.find(a => a[0] === "tag")[2], plan.images.openclaw.localTag);
    assert.equal(calls.filter(a => a[0] === "pull").length, 2);
    assert.ok(calls.every(a => ["info", "pull", "image", "tag"].includes(a[0])));
    await writeFile(log, "");
    await assert.rejects(execute(command, args, { env: { ...env, MOCK_IMAGE_BAD: "1" } }));
    const failed = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(!failed.some(a => a[0] === "tag"));
    await writeFile(log, "");
    await assert.rejects(execute(command, args, { env: { ...env, MOCK_DOCKER_DOWN: "1" } }));
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
