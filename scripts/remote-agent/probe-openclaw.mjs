import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildArguments } from "./build.mjs";
import { ensureSource, projectRoot, readLock, run } from "./source.mjs";

/** Reuse the official Linux live proof, not a mock of the desktop protocol. */
export async function probeOpenClaw() {
  const engine = "openclaw";
  const directory = join(projectRoot, "services", "remote-agent", engine);
  const lock = await readLock(engine);
  const definition = JSON.parse(await readFile(join(directory, "service.json"), "utf8"));
  const source = lock.sources.find(item => item.id === definition.build.source);
  if (!source) throw new Error("测试源码不在锁文件中");
  const upstream = await ensureSource(engine, source, { verifyOnly: true });
  const actual = await run("docker", ["image", "inspect", "--format", '{{index .Config.Labels "ai.agent-lab.desktop.source.commit"}}', definition.build.image], projectRoot, { capture: true });
  if (actual !== source.commit) throw new Error("请先成功构建锁定源码的 OpenClaw 镜像");

  // The release image intentionally excludes dev dependencies and source.
  // Native build-stage layers are already cached by remote:build.
  const sourceImage = `agent-lab/openclaw-proof-source:${source.version}-source-${source.commit.slice(0, 12)}`;
  const image = `agent-lab/openclaw-desktop-probe:${source.version}-source-${source.commit.slice(0, 12)}`;
  const proofDefinition = { ...definition, build: { ...definition.build, image: sourceImage, target: "build" } };
  await run("docker", buildArguments(proofDefinition, source, upstream), projectRoot, { timeout: 600_000 });
  await run("docker", ["build", "--progress=plain", "--file", join(directory, "tests", "desktop-probe.Dockerfile"),
    "--tag", image, "--build-arg", `SOURCE_IMAGE=${sourceImage}`, "--label", `ai.agent-lab.desktop.source.commit=${source.commit}`,
    join(directory, "tests")], projectRoot, { timeout: 600_000 });

  const artifacts = join(projectRoot, ".work", "remote-agent", engine, `desktop-${Date.now()}`);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const name = `agent-lab-openclaw-desktop-probe-${randomUUID()}`;
  let container;
  let failure;
  try {
    container = await run("docker", ["create", "--init", "--name", name, "--label", "ai.agent-lab.desktop.probe=desktop",
      "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "1024", "--shm-size", "256m", image], projectRoot, { capture: true });
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("测试容器标识无效");
    try { await run("docker", ["start", "--attach", container], projectRoot, { timeout: 480_000 }); }
    catch (error) { failure = error; }
    await run("docker", ["cp", `${container}:/proof/.`, artifacts], projectRoot, { capture: true });
    const native = JSON.parse(await readFile(join(artifacts, "result.json"), "utf8"));
    const passed = !failure && native.ok === true && native.typedMarkerReadBack === true && native.staleGenerationRejected === true && native.gatewayCleanupJoined === true;
    const report = {
      probe: "openclaw-native-managed-desktop", passed, sourceCommit: source.commit, image, artifacts,
      nativeProvider: native.provider?.id, screenshot: Boolean(native.desktopImage),
      window_screenshot: Boolean(native.beforeImage), after_screenshot: Boolean(native.afterImage),
      native_click_and_type: native.typedMarkerReadBack === true,
      stale_generation_rejected: native.staleGenerationRejected === true,
      native_cleanup_joined: native.gatewayCleanupJoined === true,
      observer_stream: "not-tested", model_driven_task: "not-tested",
      failures: native.failures,
    };
    await writeFile(join(artifacts, "probe.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(report, null, 2));
    if (!passed) throw new Error(`原生桌面验证未通过，真实截图与脱敏日志已保存：${artifacts}`);
  } finally {
    // Only the exact disposable container ID created by this invocation.
    if (container && /^[a-f0-9]{64}$/.test(container)) await run("docker", ["rm", "--force", container], projectRoot, { capture: true });
  }
}
