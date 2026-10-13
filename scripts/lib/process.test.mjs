import { test } from "node:test";
import assert from "node:assert/strict";
import { npmInvocation, run } from "./process.mjs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("npm is invoked through Node without a shell or .cmd interpolation", () => {
  assert.throws(() => npmInvocation([], { npm_execpath: "missing.cmd" }, "/missing/node"));
  if (process.env.npm_execpath?.endsWith("npm-cli.js")) {
    const invocation = npmInvocation(["ci", "--prefix", "folder with spaces", "--ignore-scripts"]);
    assert.equal(invocation.command, process.env.npm_node_execpath || process.execPath);
    assert.deepEqual(invocation.args.slice(1), ["ci", "--prefix", "folder with spaces", "--ignore-scripts"]);
  }
});

test("captures a diagnostic command and propagates failures", async () => {
  assert.match(await run(process.execPath, ["--version"], { capture: true }), /^v\d+/);
  await assert.rejects(run(process.execPath, ["-e", "process.exit(2)"], { capture: true }), /失败/);
  await assert.rejects(run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { capture: true, timeout: 30 }), /超时/);
});

test("standalone scripts discover an npm JS entry on absolute PATH when Node lives elsewhere", async () => {
  const work = fileURLToPath(new URL("../../.work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, "npm-discovery-"));
  try {
    const entry = join(root, "node_modules/npm/bin/npm-cli.js");
    await mkdir(join(root, "node_modules/npm/bin"), { recursive: true });
    await writeFile(entry, "fixture");
    const result = npmInvocation(["ci"], { PATH: root }, process.execPath);
    assert.deepEqual(result.args, [entry, "ci"]);
    assert.equal(result.command, process.execPath);
  } finally { await rm(root, { recursive: true, force: true }); }
});
