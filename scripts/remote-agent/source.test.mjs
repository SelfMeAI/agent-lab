import { test } from "node:test";
import assert from "node:assert/strict";
import { readLock, validateLock } from "./source.mjs";
import { buildArguments } from "./build.mjs";
import { useBuiltLauncher } from "../../services/remote-agent/openclaw/tests/bootstrap-native-proof.mjs";

test("both engines have pinned, distinct official sources", async () => {
  const openhands = await readLock("openhands");
  const openclaw = await readLock("openclaw");
  assert.deepEqual(openhands.sources.map(source => source.id), ["app", "sdk"]);
  assert.equal(openclaw.sources[0].repository, "https://github.com/openclaw/openclaw.git");
});

test("native desktop proof changes only the test launcher and refuses source drift", () => {
  const before = 'assert(nativeClick); spawn(process.execPath, ["scripts/run-node.mjs", "gateway", "run"], { env }); assert(staleGenerationRejected);';
  assert.equal(useBuiltLauncher(before), before.replace("scripts/run-node.mjs", "openclaw.mjs"));
  assert.throws(() => useBuiltLauncher("unexpected native fixture"));
  assert.throws(() => useBuiltLauncher(before + before));
});

test("rejects unknown engines, source traversal, floating revisions and duplicates", async () => {
  await assert.rejects(readLock("../../other"));
  const lock = await readLock("openhands");
  for (const change of [{ id: "../sdk" }, { commit: "main" }, { repository: "https://example.com/untrusted.git" }]) {
    assert.throws(() => validateLock({ ...lock, sources: [{ ...lock.sources[0], ...change }] }, "openhands"));
  }
  assert.throws(() => validateLock({ ...lock, sources: [lock.sources[0], lock.sources[0]] }, "openhands"));
});

test("source builds keep argument boundaries and never resolve outside the source", async () => {
  const source = (await readLock("openhands")).sources[1];
  const definition = { schemaVersion: 1, id: "openhands", build: { source: "sdk", dockerfile: "docker/Dockerfile", image: "selfme-lab/openhands:test", target: "source", args: { INSTALL_ACP_PROVIDERS: "" } } };
  const args = buildArguments(definition, source, "/workspace/source");
  assert.ok(args.includes("INSTALL_ACP_PROVIDERS="));
  assert.ok(args.includes(`ai.selfme.lab.source.commit=${source.commit}`));
  assert.equal(args.at(-1), "/workspace/source");
  assert.throws(() => buildArguments({ ...definition, build: { ...definition.build, dockerfile: "../../outside/Dockerfile" } }, source, "/workspace/source"));
});
