import { test } from "node:test";
import assert from "node:assert/strict";
import { requireDocker } from "./docker.mjs";

test("missing Docker gives installation guidance without running a command", async t => {
  const runCommand = t.mock.fn();
  await assert.rejects(requireDocker({ platform: "darwin", env: {}, accessFile: async () => { throw new Error("ENOENT"); }, runCommand }), /未找到 Docker 命令.*仅用于远端实验室/);
  assert.equal(runCommand.mock.callCount(), 0);
});

test("finds GUI-installed Docker outside PATH and only reads its Linux engine status", async t => {
  const env = { PATH: "relative:." };
  const runCommand = t.mock.fn(async (command, args, options) => {
    assert.equal(command, "/Applications/Docker.app/Contents/Resources/bin/docker");
    assert.deepEqual(args, ["info", "--format", "{{.ServerVersion}}|{{.OSType}}"]);
    assert.equal(options.env, env);
    return "29.0.1|linux\n";
  });
  const result = await requireDocker({ platform: "darwin", env, accessFile: async path => {
    if (!path.startsWith("/Applications/Docker.app/")) throw new Error("ENOENT");
  }, runCommand });
  assert.equal(result.version, "29.0.1");
  assert.equal(runCommand.mock.callCount(), 1);
});

test("an unavailable engine gives startup/context guidance without exposing raw output", async () => {
  const error = await requireDocker({ platform: "linux", env: {}, accessFile: async () => {}, runCommand: async () => { throw new Error("private daemon context and token"); } }).catch(error => error);
  assert.match(error.message, /Docker 已安装.*服务未就绪或无法连接/);
  assert.match(error.message, /context 和访问权限/);
  assert.doesNotMatch(error.message, /private daemon|token/);
});

test("rejects Windows-container mode and malformed engine information", async () => {
  const base = { platform: "win32", env: {}, accessFile: async () => {} };
  await assert.rejects(requireDocker({ ...base, runCommand: async () => "29.0.1|windows" }), /Linux 容器模式/);
  await assert.rejects(requireDocker({ ...base, runCommand: async () => "" }), /无法确认/);
});
