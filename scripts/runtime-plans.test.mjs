import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readJson } from "./lib/artifacts.mjs";
import { codexBuildPlan } from "./build-codex-runtime.mjs";
import { ollamaArtifact } from "./ensure-ollama-runtime.mjs";
import { supportsNode } from "./doctor.mjs";
import { codexRuntimeFiles, dockerCliCandidates, ollamaExecutableRelativePath, runtimeTarget, runtimeTargets } from "../runtimes/platform.mjs";
import { packagePlan } from "./package-desktop.mjs";

test("all runtime targets have explicit source-build bins, locked V8 inputs and official Ollama archives", async () => {
  const codex = await readJson(new URL("../runtimes/codex/source.json", import.meta.url));
  const ollama = await readJson(new URL("../runtimes/ollama/runtime.json", import.meta.url));
  for (const key of runtimeTargets) {
    const [platform, arch] = key.split("-"), target = runtimeTarget(platform, arch), plan = codexBuildPlan(codex, target), archive = ollamaArtifact(ollama, target);
    assert.ok(plan.cargoArgs.includes("--locked"));
    assert.ok(plan.binaries.includes("codex-code-mode-host"));
    assert.match(plan.hashes.archive, /^[a-f0-9]{64}$/);
    assert.match(plan.hashes.binding, /^[a-f0-9]{64}$/);
    assert.ok(archive.url.startsWith("https://github.com/ollama/ollama/releases/download/v0.35.0/"));
    if (platform === "win32") {
      assert.ok(plan.binaries.includes("codex-windows-sandbox-setup"));
      assert.ok(plan.files.includes("codex-resources/codex-command-runner.exe"));
      assert.equal(ollamaExecutableRelativePath(platform), "native/ollama.exe");
    }
    if (platform === "linux") {
      assert.ok(plan.binaries.includes("bwrap")); assert.ok(codexRuntimeFiles(platform).includes("codex-resources/bwrap"));
      assert.equal(ollamaExecutableRelativePath(platform), "native/bin/ollama");
    }
  }
});

test("environment requirements include the Node baseline required by Pi and Kimi", () => {
  for (const version of ["22.12.0", "22.18.0", "20.20.0"]) assert.equal(supportsNode(version), false);
  for (const version of ["22.19.0", "24.0.0", "26.5.1"]) assert.equal(supportsNode(version), true);
});

test("source CI restores the real Kimi and Qwen fixtures before running their tests", async () => {
  const workflow = await readFile(new URL("../.github/workflows/check.yml", import.meta.url), "utf8");
  const tests = workflow.indexOf("run: npm test");
  assert.ok(tests > 0);
  for (const command of ["npm ci --no-audit --no-fund", "npm run ensure:kimi", "npm run ensure:qwen"]) {
    const prepared = workflow.indexOf(`run: ${command}`);
    assert.ok(prepared >= 0 && prepared < tests, `${command} must precede tests in a clean checkout`);
  }
});

test("Docker discovery supports GUI defaults and absolute PATH entries without shell evaluation", () => {
  assert.ok(dockerCliCandidates("linux", { PATH: "/custom/bin:.:relative" }).includes("/custom/bin/docker"));
  assert.ok(dockerCliCandidates("linux", {}).includes("/usr/bin/docker"));
  assert.ok(!dockerCliCandidates("linux", { PATH: ".:relative" }).includes("docker"));
  const windows = dockerCliCandidates("win32", { Path: "C:\\Docker CLI;." });
  assert.ok(windows.includes("C:\\Docker CLI\\docker.exe"));
  assert.ok(windows.includes("C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"));
});

test("packaging is native-only and never publishes automatically", () => {
  const plan = packagePlan(process.platform, process.arch, true);
  assert.ok(plan.args.includes("--dir")); assert.equal(plan.args.at(-1), "never");
  assert.ok(!plan.output.includes("/"));
  assert.throws(() => packagePlan(process.platform === "win32" ? "darwin" : "win32", "x64"), /原生构建机/);
});
