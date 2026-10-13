import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic } from "./lib/artifacts.mjs";
import { ensurePiDependencies } from "./ensure-pi-dependencies.mjs";

test("Pi shrinkwrap correction has a fixed SDK/patch boundary and no silent upgrades", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const lock = await readJson(join(root, "package-lock.json"));
  const key = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
  assert.equal(lock.packages[key].version, "5.0.12");
  await mkdir(join(root, ".work"), { recursive: true });
  const scratch = await mkdtemp(join(root, ".work/pi-restore-"));
  const sdk = join(scratch, "node_modules/@earendil-works/pi-coding-agent");
  try {
    await writeJsonAtomic(join(scratch, "package-lock.json"), { packages: { [key]: lock.packages[key] } });
    await writeJsonAtomic(join(sdk, "package.json"), { version: "0.87.1" });
    await writeJsonAtomic(join(sdk, "node_modules/brace-expansion/package.json"), { version: "5.0.12" });
    await ensurePiDependencies(scratch);
    await writeJsonAtomic(join(sdk, "node_modules/brace-expansion/package.json"), { version: "unrecognized" });
    await assert.rejects(ensurePiDependencies(scratch), /未覆盖/);
    await writeJsonAtomic(join(sdk, "package.json"), { version: "0.88.0" });
    await assert.rejects(ensurePiDependencies(scratch), /版本已变化/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
