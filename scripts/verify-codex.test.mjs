import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexRuntimeFiles, executableName, runtimeTarget, runtimeTargets } from "../runtimes/platform.mjs";
import { readJson, sha256, writeJsonAtomic } from "./lib/artifacts.mjs";
import { verifyCodex } from "./verify-codex-runtime.mjs";

test("source-build verifier refuses missing hosts, modified files, wrong source or foreign package metadata on every layout", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url)), manifest = await readJson(join(root, "runtimes/codex/source.json"));
  await mkdir(join(root, ".work"), { recursive: true });
  const scratch = await mkdtemp(join(root, ".work/codex-verify-"));
  try {
    for (const key of runtimeTargets) {
      const [platform, arch] = key.split("-"), target = runtimeTarget(platform, arch), runtime = join(scratch, key), files = codexRuntimeFiles(platform);
      const hashes = {};
      for (const path of files) { await mkdir(dirname(join(runtime, path)), { recursive: true }); await writeFile(join(runtime, path), path, { mode: 0o755 }); hashes[path] = await sha256(join(runtime, path)); }
      const marker = { layoutVersion: 1, version: manifest.version, target: target.rustTarget, entrypoint: `bin/${executableName("codex", platform)}`, resourcesDir: "codex-resources", pathDir: "codex-path" };
      const receipt = { schemaVersion: 1, version: manifest.version, commit: manifest.commit, target: key, rustToolchain: manifest.rustToolchain, v8Version: manifest.v8.version, files: hashes };
      await writeJsonAtomic(join(runtime, "codex-package.json"), marker); await writeJsonAtomic(join(runtime, "build-receipt.json"), receipt);
      assert.equal((await verifyCodex({ root, runtime, target })).provenance, "source-build");
      await writeJsonAtomic(join(runtime, "build-receipt.json"), { ...receipt, commit: "0".repeat(40) });
      await assert.rejects(verifyCodex({ root, runtime, target }), /固定源码/);
      await writeJsonAtomic(join(runtime, "build-receipt.json"), receipt);
      await writeJsonAtomic(join(runtime, "codex-package.json"), { ...marker, target: "foreign" });
      await assert.rejects(verifyCodex({ root, runtime, target }), /平台/);
      await writeJsonAtomic(join(runtime, "codex-package.json"), marker);
      await writeFile(join(runtime, files[0]), "modified");
      await assert.rejects(verifyCodex({ root, runtime, target }), /校验失败/);
      await writeFile(join(runtime, files[0]), files[0]);
      await rm(join(runtime, files[1]));
      await assert.rejects(verifyCodex({ root, runtime, target }));
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
