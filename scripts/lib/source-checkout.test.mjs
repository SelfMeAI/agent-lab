import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCheckout } from "./source-checkout.mjs";
import { run } from "./process.mjs";

test("fixed-source checkout verifies provenance and refuses changes without network access", async () => {
  const work = fileURLToPath(new URL("../../.work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, "checkout-test-")), directory = join(root, "source");
  const repository = "https://github.com/openai/codex.git";
  try {
    await mkdir(directory);
    await run("git", ["init", "--quiet"], { cwd: directory });
    await run("git", ["remote", "add", "origin", repository], { cwd: directory });
    await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "fixture"], { cwd: directory });
    const commit = await run("git", ["rev-parse", "HEAD"], { cwd: directory, capture: true });
    const input = { root, directory, repository, commit, verifyOnly: true };
    assert.equal(await ensureCheckout(input), directory);
    await ensureCheckout({ ...input, verifyOnly: false, platform: "win32" });
    assert.equal(await run("git", ["config", "--local", "core.longpaths"], { cwd: directory, capture: true }), "true");
    await assert.rejects(ensureCheckout({ ...input, commit: "0".repeat(40) }), /固定提交/);
    await assert.rejects(ensureCheckout({ ...input, repository: "https://github.com/example/other.git" }), /来源/);
    await assert.rejects(ensureCheckout({ ...input, directory: join(root, "..", "outside") }), /项目目录/);
    await writeFile(join(directory, "work.txt"), "do not overwrite");
    await assert.rejects(ensureCheckout(input), /存在修改/);
    await mkdir(join(root, "not-git"));
    await writeFile(join(root, "not-git", "work.txt"), "keep");
    await assert.rejects(ensureCheckout({ ...input, directory: join(root, "not-git"), verifyOnly: false }), /未覆盖/);
    if (process.platform !== "win32") {
      await symlink(directory, join(root, "linked"));
      await assert.rejects(ensureCheckout({ ...input, directory: join(root, "linked") }), /符号链接/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
