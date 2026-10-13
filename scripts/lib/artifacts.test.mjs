import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasChecksum, readJson, sha256, verifyFileHashes, writeJsonAtomic } from "./artifacts.mjs";

test("generated receipts validate files, required companions, digests and path boundaries", async () => {
  const work = fileURLToPath(new URL("../../.work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, "artifact-test-"));
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/tool"), "fixture");
    const hashes = { "bin/tool": await sha256(join(root, "bin/tool")) };
    assert.equal(await hasChecksum(join(root, "absent"), hashes["bin/tool"]), false);
    await verifyFileHashes(root, hashes, ["bin/tool"]);
    await assert.rejects(verifyFileHashes(root, hashes, ["bin/host"]), /必要文件/);
    await assert.rejects(verifyFileHashes(root, { "../secret": hashes["bin/tool"] }, []), /无效/);
    await assert.rejects(verifyFileHashes(root, { "bin/tool": "0".repeat(64) }, []), /校验失败/);
    await writeJsonAtomic(join(root, "receipt.json"), hashes);
    assert.deepEqual(await readJson(join(root, "receipt.json")), hashes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
