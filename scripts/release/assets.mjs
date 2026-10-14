import assert from "node:assert/strict";
import { copyFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { releasePlan, root, digestReference, imageTargets } from "./manifest.mjs";
import { readJson, sha256, writeJsonAtomic } from "../lib/artifacts.mjs";
import { verifyCodexSource } from "./codex-source.mjs";

export function renderPreparation(template, plan, images) {
  const fields = { VERSION: plan.version, COMMIT: plan.commit, DOCUMENT_PREVIEW: plan.documentPreview };
  for (const engine of ["openhands", "openclaw"]) {
    const definition = plan.images[engine], image = images.images?.[engine];
    if (images.version !== plan.version || images.commit !== plan.commit || image?.localTag !== definition.localTag || image?.upstreamCommit !== definition.upstreamCommit) throw new Error("发布清单的镜像版本与客户端不匹配");
    assert.deepEqual([...image.platforms].sort(), imageTargets.map(target => `linux/${target.arch}`).sort());
    fields[`${engine.toUpperCase()}_IMAGE`] = digestReference(definition.repository, image.digest);
    fields[`${engine.toUpperCase()}_TAG`] = definition.localTag;
    fields[`${engine.toUpperCase()}_COMMIT`] = definition.upstreamCommit;
  }
  const result = template.replace(/@([A-Z_]+)@/g, (_, key) => {
    if (!Object.hasOwn(fields, key)) throw new Error(`未知准备脚本占位符：${key}`);
    return fields[key];
  });
  if (/@[A-Z_]+@/.test(result)) throw new Error("准备脚本仍含未填充的占位符");
  return result;
}
export function verifyDesktopReceipt(plan, target, receipt) {
  if (receipt.schemaVersion !== 1 || receipt.version !== plan.version || receipt.commit !== plan.commit || receipt.target !== target.id || receipt.verified !== true
    || !["distribution-payload", "packaged-window", "four-labs", "six-bundled-harnesses", "fresh-settings-and-sessions", "native-executables", "bundled-harness-integration"].every(check => receipt.checks?.includes(check))) throw new Error(`桌面安装包尚未通过完整发布验收：${target.id}`);
  const names = target.extensions.map(extension => `Agent-Lab-${plan.version}-${target.id}.${extension}`);
  assert.deepEqual(receipt.files, names, "安装包文件记录不匹配");
  return names;
}
async function checkInstaller(path, extension) {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1024) throw new Error("安装包为空或不是常规文件");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4);
    await file.read(bytes, 0, 4, extension === "dmg" ? info.size - 512 : 0);
    const expected = extension === "dmg" ? "6b6f6c79" : extension === "zip" ? "504b0304" : extension === "exe" ? "4d5a" : "7f454c46";
    if (!bytes.toString("hex").startsWith(expected)) throw new Error(`安装包格式校验失败：${extension}`);
  } finally { await file.close(); }
}
export async function verifyPublicImages(plan, images, request = fetch) {
  for (const [engine, definition] of Object.entries(plan.images)) {
    const image = images.images[engine], path = definition.repository.slice("ghcr.io/".length);
    digestReference(definition.repository, image.digest);
    // Deliberately no GitHub/Docker credential. A successful authenticated push
    // does not prove that a person can download a public release anonymously.
    const tokenResponse = await request(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${path}:pull`)}`, { signal: AbortSignal.timeout(30_000) });
    if (!tokenResponse.ok) throw new Error(`${engine} 镜像不可匿名下载。请把 GitHub Packages 中对应容器包的 Visibility 设为 Public，再重试发布步骤。`);
    const token = (await tokenResponse.json()).token;
    if (typeof token !== "string" || !token) throw new Error("Registry 未返回匿名拉取令牌");
    const response = await request(`https://ghcr.io/v2/${path}/manifests/${image.digest}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || response.headers.get("docker-content-digest") !== image.digest) throw new Error(`${engine} 公开镜像 digest 未通过验证，未发布 Release。`);
    const manifest = await response.json();
    for (const target of imageTargets) {
      if (!manifest.manifests?.some(item => item.platform?.os === "linux" && item.platform?.architecture === target.arch)) throw new Error(`${engine} 公开镜像缺少 linux/${target.arch}`);
    }
  }
}
export function releaseNotes(plan) {
  const targets = plan.desktop.map(target => `- **${target.id}**：${target.extensions.join(" / ")}`).join("\n");
  const codexNotes = plan.desktop.some(target => target.platform === "linux")
    ? `Linux 的 bwrap/bubblewrap 对应源码及构建说明另见 \`Agent-Lab-${plan.version}-codex-component-source.tar.gz\`；运行应用无需下载源码附件。\n\n` : "";
  const linuxNotes = plan.desktop.some(target => target.platform === "linux")
    ? "Linux AppImage 需要 FUSE 2（Ubuntu 24.04：libfuse2t64）；无法使用 FUSE 时可用 `./Agent-Lab-" + plan.version + "-linux-x64.AppImage --appimage-extract-and-run`。见 [AppImage 官方指南](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)。Electron 沙箱需要发行版允许的用户命名空间；不要全局关闭 AppArmor 或沙箱。Codex 在 Linux/WSL2 还需要发行版的 bubblewrap（Ubuntu/Debian：`sudo apt install bubblewrap`），并按 [OpenAI 官方沙箱前提](https://learn.chatgpt.com/docs/sandboxing#prerequisites) 配置 bwrap 的用户命名空间权限。保存 Key 需要桌面 Secret Service/KWallet。\n\n" : "";
  return `# Agent Lab ${plan.version}\n\n面向智能体研发与能力验证的实验平台。首批发行使用 Pre-release 标记；不作为生产级多租户或安全沙箱承诺。\n\n## 下载与启动（无需源码）\n\n${targets}\n\n1. 下载对应系统/CPU 的安装包，先核对 \`SHA256SUMS.txt\`。macOS 安装 DMG 或解压 ZIP；Windows 使用 EXE；Linux 为 AppImage（Ubuntu 24.04 / glibc 环境），赋予执行权限后运行。\n2. Agent Lab 内置六种本地 Harness 与 Ollama，不需要安装 Node、Rust、Python，也不需要另外安装这些 CLI。API Key 和模型权重不随包分发，请在各实验室的设置中配置自己的连接。Codex 需要 Responses API，Claude Agent 需要 Anthropic Messages API。\n3. 仅使用 Remote Agent Lab 时，先安装并启动 Docker Desktop 或 Docker Engine，使用 Linux 容器（amd64 / arm64；Docker 26+）。建议至少给 Docker 8 GB 内存，并为镜像/构建缓存预留数十 GB 磁盘空间。\n4. 在本版本附件中下载镜像准备脚本，终端切到文件所在目录：\n\nmacOS / Linux：\n\n\`\`\`sh\nsh prepare-remote.sh\n# 只准备一个服务：sh prepare-remote.sh openclaw\n\`\`\`\n\nWindows PowerShell：\n\n\`\`\`powershell\npowershell -NoProfile -ExecutionPolicy Bypass -File .\\prepare-remote.ps1\n# 只对本次命令生效，不修改系统执行策略\n\`\`\`\n\n5. 回到 Remote Agent Lab → 服务管理，启动所需服务，再配置自己的模型/API 连接。脚本使用公开的固定 digest 镜像，不要求 GitHub 登录；不修改代理、DNS、Docker context，也不删除容器或数据卷。\n\n其他三个实验室不依赖 Docker。Ollama 推理还需下载模型并满足对应内存/显存要求；JEV 真实决策需自行配置 API，未配置时可能使用界面标明的本地规则回退。\n\n${linuxNotes}## 验证范围与安全提示\n\n本次列出的安装包从最终分发内容启动验收（macOS ZIP、Linux AppImage 解包；Windows 在隔离 CI 中安装 EXE），通过原生构建、实际窗口/IPC 启动、六个内置 Harness 加载与本地模拟模型交互回归；两种远端镜像通过 amd64/arm64 容器集成验收，并验证公开匿名下载。这些自动验收不代替所有真实设备、模型服务商或发行版兼容性测试。\n\nmacOS 包未签名/公证，Windows 包未做代码签名，无自动更新。系统可能提示来源无法验证；请核对来源后按系统正常流程处理，不要全局关闭安全保护。Linux 保存连接密钥需要可用的 Secret Service/KWallet；没有系统密钥服务时会拒绝保存。\n\n安装包和镜像不含个人配置、会话、API Key 或模型权重。现有安装的应用数据/远端数据卷保留；关闭客户端不会停止远端服务，删除数据卷会丢失远端记录和文件。\n\n\`release-manifest.json\` 列出版本、源码 commit、镜像 digest 和安装包 SHA-256。桌面组件对应源码在 \`Agent-Lab-${plan.version}-desktop-component-source.tar.gz\`，也保存在 OpenClaw 镜像的 \`/opt/agent-lab/desktop/sources\`；各依赖适用自身许可，Claude 官方文件适用 Anthropic 条款，使用者自行提供凭据。\n\n${codexNotes}源码：[${plan.commit.slice(0, 12)}](https://github.com/${plan.repository}/tree/${plan.commit}) · [完整 README](https://github.com/${plan.repository}/blob/${plan.commit}/README.md)\n\n普通 push 只触发源码检查；安装包和镜像发版由 Release workflow 单独手动触发。\n`;
}
export async function collectAssets(plan, input, output) {
  const images = await readJson(join(input, "images.json"));
  // Rendering validates all pinned image identities before any files are staged.
  const shell = renderPreparation(await readFile(join(root, "scripts/release/prepare-remote.sh"), "utf8"), plan, images);
  const powershell = renderPreparation(await readFile(join(root, "scripts/release/prepare-remote.ps1"), "utf8"), plan, images);
  const installers = [], names = [];
  for (const target of plan.desktop) {
    const receipt = await readJson(join(input, `desktop-${target.id}.json`));
    for (const name of verifyDesktopReceipt(plan, target, receipt)) {
      await checkInstaller(join(input, name), name.split(".").at(-1));
      installers.push({ target: target.id, file: name, sha256: await sha256(join(input, name)), checks: receipt.checks });
      names.push(name);
    }
  }
  const sourceName = `Agent-Lab-${plan.version}-desktop-component-source.tar.gz`;
  if (!(await stat(join(input, sourceName))).isFile()) throw new Error("缺少桌面组件对应源码，不能发布其二进制");
  const codexSource = plan.desktop.some(target => target.platform === "linux") ? await verifyCodexSource(plan, input) : undefined;
  const sourceFiles = [sourceName, ...(codexSource ? [codexSource.file] : [])];
  await mkdir(output, { recursive: true });
  for (const name of [...names, ...sourceFiles]) await copyFile(join(input, name), join(output, name));
  await writeFile(join(output, "prepare-remote.sh"), shell, { mode: 0o755 });
  // Windows PowerShell 5.1 needs a UTF-8 BOM for these Chinese messages.
  await writeFile(join(output, "prepare-remote.ps1"), `\uFEFF${powershell}`);
  await writeFile(join(output, "RELEASE.md"), releaseNotes(plan));
  await writeJsonAtomic(join(output, "release-manifest.json"), { schemaVersion: 1, version: plan.version, tag: plan.tag, repository: plan.repository, commit: plan.commit,
    desktop: installers, images: images.images, documentPreview: plan.documentPreview, desktopComponentSource: { file: sourceName, sha256: await sha256(join(output, sourceName)) },
    ...(codexSource ? { codexComponentSource: codexSource } : {}) });
  const files = [...names, ...sourceFiles, "prepare-remote.sh", "prepare-remote.ps1", "RELEASE.md", "release-manifest.json"];
  const lines = await Promise.all(files.map(async name => `${await sha256(join(output, name))}  ${name}`));
  await writeFile(join(output, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
  console.log(`发布附件校验并准备完成 · ${files.length + 1} 个文件 · 不包含测试配置、日志或数据库。`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  releasePlan({ version: value("--version"), repository: value("--repository"), targets: value("--targets") }).then(async plan => {
    const input = resolve(value("--directory") ?? join(root, ".work/release-artifacts"));
    if (args.includes("--verify-public")) await verifyPublicImages(plan, await readJson(join(input, "images.json")));
    else await collectAssets(plan, input, resolve(value("--output") ?? join(root, ".work/release-publish")));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
