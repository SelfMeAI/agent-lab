import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot, readLock, run } from "./source.mjs";

const engine = process.argv[2];
if (process.argv.includes("--help")) {
  console.log("npm run remote:probe -- <openhands|openclaw> [--desktop] — 原生浏览器 / Linux 受管桌面验证；OpenHands --desktop 补测可见浏览器与只读画面流；不需要模型密钥");
  process.exit(0);
}
if (engine === "openclaw") {
  const { probeOpenClaw } = await import("./probe-openclaw.mjs");
  await probeOpenClaw();
  process.exit(0);
}
if (engine !== "openhands") throw new Error("请选择 openhands 或 openclaw");
const lock = await readLock(engine);
const definition = JSON.parse(await readFile(join(projectRoot, "services", "remote-agent", engine, "service.json"), "utf8"));
const source = lock.sources.find(source => source.id === definition.build.source);
let image = definition.build.image;
const actual = await run("docker", ["image", "inspect", "--format", '{{index .Config.Labels "ai.agent-lab.desktop.source.commit"}}', image], projectRoot, { capture: true });
if (actual !== source.commit) throw new Error("测试镜像不是锁定源码构建的镜像");
if (process.argv.includes("--desktop")) {
  const baseline = image;
  image = `agent-lab/openhands-desktop-probe:${source.version}-source-${source.commit.slice(0, 12)}`;
  const tests = join(projectRoot, "services", "remote-agent", engine, "tests");
  await run("docker", ["build", "--progress=plain", "--file", join(tests, "desktop-probe.Dockerfile"), "--tag", image,
    "--build-arg", `SOURCE_IMAGE=${baseline}`, "--label", `ai.agent-lab.desktop.source.commit=${source.commit}`, tests], projectRoot, { timeout: 600_000 });
}
const input = await readFile(join(projectRoot, "services", "remote-agent", engine, "tests", "browser_probe.py"));

const output = await new Promise((resolve, reject) => {
  const child = spawn("docker", ["run", "--rm", "--interactive", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--shm-size", "256m", "--env", "OPENHANDS_SUPPRESS_BANNER=1", "--entrypoint", "/agent-server/.venv/bin/python", image, "-"], { cwd: projectRoot, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout = (stdout + data.toString()).slice(-1_000_000); });
  child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-16_000); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
  child.stdin.on("error", () => { /* Docker failure is reported by its exit status. */ });
  child.stdin.end(input);
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});
const line = output.stdout.split(/\r?\n/).find(line => line.startsWith('{"probe": "openhands-native-browser"'));
if (!line) throw new Error(`原生浏览器验证没有产生结构化结果：${output.stderr.slice(-4000)}`);
const report = JSON.parse(line);
const artifacts = join(projectRoot, ".work", "remote-agent", engine, `browser-${Date.now()}`);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
for (const [name, screenshot] of Object.entries(report.screenshots ?? {})) {
  await writeFile(join(artifacts, `${name}.png`), Buffer.from(screenshot, "base64"));
}
delete report.screenshots;
Object.assign(report, { sourceCommit: source.commit, image, artifacts });
await writeFile(join(artifacts, "result.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (output.code !== 0 || !report.passed) throw new Error(`原生浏览器验证失败，保留了真实画面和观察结果：${artifacts}`);
