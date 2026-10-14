import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import { releasePlan, root } from "./manifest.mjs";
import { run, runNpm } from "../lib/process.mjs";
import { writeJsonAtomic } from "../lib/artifacts.mjs";
import { executableName, ollamaExecutableRelativePath } from "../../runtimes/platform.mjs";

export function packagedLayout(platform = process.platform, arch = process.arch) {
  const suffix = arch === "x64" ? "" : `-${arch}`;
  if (platform === "darwin") {
    const app = join(root, "release", `mac${suffix}`, "Agent Lab.app", "Contents");
    return { executable: join(app, "MacOS", "Agent Lab"), resources: join(app, "Resources"),
      node: join(app, "Frameworks/Agent Lab Helper.app/Contents/MacOS/Agent Lab Helper"), target: `mac-${arch}` };
  }
  const directory = join(root, "release", `${platform === "win32" ? "win" : "linux"}${suffix}-unpacked`);
  const executable = join(directory, platform === "win32" ? "Agent Lab.exe" : "agent-lab");
  return { executable, resources: join(directory, "resources"), node: executable, target: `${platform === "win32" ? "win" : "linux"}-${arch}` };
}

export function distributionLayout(directory, platform = process.platform, arch = process.arch) {
  if (platform === "darwin") {
    const contents = join(directory, "Agent Lab.app/Contents");
    return { executable: join(contents, "MacOS/Agent Lab"), resources: join(contents, "Resources"),
      node: join(contents, "Frameworks/Agent Lab Helper.app/Contents/MacOS/Agent Lab Helper"), target: `mac-${arch}` };
  }
  const app = join(directory, platform === "win32" ? "installed" : "squashfs-root");
  const executable = join(app, platform === "win32" ? "Agent Lab.exe" : "agent-lab");
  return { executable, resources: join(app, "resources"), node: executable, target: `${platform === "win32" ? "win" : "linux"}-${arch}` };
}

async function extractDistribution(plan, target) {
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS !== "true")
    throw new Error("Windows 安装程序验收只在隔离的 GitHub Actions 环境运行，避免影响本机已有安装；本机可用打包目录手动体验。");
  const directory = await mkdtemp(join(root, ".work/release-installation-"));
  const archive = extension => join(root, "release", `Agent-Lab-${plan.version}-${target.id}.${extension}`);
  if (process.platform === "darwin") {
    await run("hdiutil", ["verify", archive("dmg")], { capture: true, timeout: 180_000 });
    await run("ditto", ["-x", "-k", archive("zip"), directory], { timeout: 180_000 });
  } else if (process.platform === "linux") {
    // Inspect/run the distributed payload without requiring FUSE on a CI host.
    // This is extraction, not permission escalation or a production default.
    await run(archive("AppImage"), ["--appimage-extract"], { cwd: directory, capture: true, maxBuffer: 20_000_000, timeout: 180_000 });
  } else {
    await run(archive("exe"), ["/S", `/D=${join(directory, "installed")}`], { timeout: 180_000 });
  }
  return { directory, layout: distributionLayout(directory) };
}

export async function smokeDesktop(args = []) {
  const plan = await releasePlan();
  const target = plan.desktop.find(target => target.id === packagedLayout().target);
  if (!target) throw new Error("此原生平台不在发布矩阵中");
  for (const extension of target.extensions) await access(join(root, "release", `Agent-Lab-${plan.version}-${target.id}.${extension}`));
  await mkdir(join(root, ".work"), { recursive: true });
  const installation = await extractDistribution(plan, target), layout = installation.layout;
  await access(layout.executable); await access(layout.node);
  const testData = await mkdtemp(join(root, ".work/release-desktop-"));
  const screenshots = join(root, "output/playwright/release", layout.target);
  await mkdir(screenshots, { recursive: true });
  const env = { ...process.env, AGENT_LAB_TEST_APP_DATA: testData };
  for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[key];
  // Ubuntu hosted runners restrict unprivileged user namespaces. The exception
  // is confined to this CI process, never a production startup default.
  const instance = await electron.launch({ executablePath: layout.executable, env, args: process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : [], timeout: 90_000 });
  const errors = [];
  try {
    const page = await instance.firstWindow();
    page.on("pageerror", error => errors.push(error.message));
    await page.locator(".lab-card").first().waitFor({ timeout: 60_000 });
    assert.equal(await page.locator(".lab-card").count(), 4, "安装包必须保留四个实验室入口");
    const info = await page.evaluate(() => window.agentLab.getAppInfo());
    assert.equal(info.name, "Agent Lab"); assert.equal(info.version, plan.version);
    assert.equal(info.platform, process.platform); assert.equal(info.arch, process.arch);
    const data = await instance.evaluate(({ app }) => app.getPath("userData"));
    assert.equal(data, join(testData, "Agent Lab"), "安装包必须使用隔离测试配置，不能读原来的用户数据");
    const statuses = await page.evaluate(() => window.agentLab.listRuntimes());
    assert.equal(statuses.length, 6);
    assert.deepEqual(statuses.filter(item => item.availability !== "ready"), [], "六个内置 Harness 必须实际可加载");
    for (const id of ["dsh", "codex", "pi", "kimi-code", "qwen-code", "claude-code", "jev"]) {
      const status = await page.evaluate(id => window.agentLab.getProviderStatus(id), id);
      assert.equal(status.configured, false, `${id} 不得携带个人 API 连接`);
    }
    for (const id of ["dsh", "codex", "pi", "kimi-code", "qwen-code", "claude-code"]) {
      const catalog = await page.evaluate(id => window.agentLab.getAgentSessionCatalog(id), id);
      assert.deepEqual(catalog.sessions, []); assert.deepEqual(catalog.deletedSessions, []);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1), false, "首页不应出现全局滚动");
    await page.screenshot({ path: join(screenshots, "home.png") });
    for (const id of ["agent-lab", "remote-agent-lab", "local-model-lab", "jev-lab"]) {
      await page.locator(`.lab-card[data-lab-id="${id}"]`).click();
      await page.waitForFunction(id => location.hash === `#/lab/${id}`, id);
      await page.waitForFunction(() => !document.querySelector(".lab-card"));
      await page.screenshot({ path: join(screenshots, `${id}.png`) });
      await page.evaluate(() => { location.hash = "#/"; });
      await page.locator(".lab-card").first().waitFor();
    }
    assert.deepEqual(errors, [], "安装包 Renderer 不得出现异常");
  } finally { await instance.close(); }
  const commands = [
    [join(layout.resources, "codex/bin", executableName("codex")), ["--version"]],
    [join(layout.resources, "codex/codex-resources", executableName("codex-code-mode-host")), ["--help"]],
    [join(layout.resources, "claude/bin", executableName("claude")), ["--version"]],
    [join(layout.resources, "ollama", ollamaExecutableRelativePath()), ["--version"]],
  ];
  for (const [command, options] of commands) await run(command, options, { capture: true, timeout: 60_000 });
  if (!args.includes("--skip-harness-tests")) {
    await runNpm(["run", "test", "--workspace", "@agent-lab/desktop", "--",
      "packages/runtime/src/steering.integration.test.ts", "packages/runtime/src/user-questions.integration.test.ts",
      "packages/runtime/src/qwen.integration.test.ts", "packages/runtime/src/claude.integration.test.ts", "packages/runtime/src/claude-permissions.integration.test.ts"], {
      cwd: root, timeout: 600_000, env: { AGENT_LAB_STEERING_INTEGRATION: "1", AGENT_LAB_STEERING_RUNTIME_ROOT: layout.resources,
        AGENT_LAB_STEERING_NODE_EXECUTABLE: layout.node, ELECTRON_RUN_AS_NODE: "1" },
    });
  }
  const receipt = { schemaVersion: 1, version: plan.version, commit: plan.commit, target: layout.target, verified: true,
    checks: ["distribution-payload", "packaged-window", "four-labs", "six-bundled-harnesses", "fresh-settings-and-sessions", "native-executables", ...(args.includes("--skip-harness-tests") ? [] : ["bundled-harness-integration"])],
    files: target.extensions.map(extension => `Agent-Lab-${plan.version}-${target.id}.${extension}`) };
  await writeJsonAtomic(join(root, "release", `desktop-${layout.target}.json`), receipt);
  if (process.platform === "win32") await run(join(installation.directory, "installed/Uninstall Agent Lab.exe"), ["/S"], { timeout: 180_000 });
  await rm(installation.directory, { recursive: true, force: true });
  console.log(`安装包原生检查完成：${layout.target}；测试配置与截图仅在 .work/ 和 output/playwright/ 中。`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  smokeDesktop(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
