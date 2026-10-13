<div align="center">
  <img src="assets/brand/agent-lab-app-icon.png" width="100" alt="Agent Lab logo" />
  <h1>Agent Lab</h1>
  <p><strong>把智能体放到同一张实验台上。</strong></p>
  <p>本地 Harness · 自部署远端 Agent · 本地模型 · 决策实验</p>
  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#四个实验室">四个实验室</a> ·
    <a href="#服务端部署">服务端部署</a> ·
    <a href="#桌面打包">桌面打包</a> ·
    <a href="#数据与安全">数据与安全</a>
  </p>
</div>

<p align="center"><img src="assets/screenshots/lab-index.jpg" width="1080" alt="Agent Lab 实机首页：四个独立实验室" /></p>

Agent Lab 是一个 **Electron + TypeScript 桌面实验平台**。它把不同智能体、模型和决策能力放进一个可运行的应用，保留各自适合的工作方式，方便实际体验、比较和积累技术。

这里不是重新实现六套 Harness，也不是宣称已经做完生产级多租户平台。我们复用上游运行时，重点打磨连接、会话、过程展示、审批、产物与实验交互。不同 Harness 的工具、权限、上下文和扩展能力仍有差异，不会因为使用同一个界面就自动变得完全等价。

**当前状态：macOS Apple Silicon 已本机验证；其他平台已有运行时恢复、打包配置和原生 CI，尚待对应设备验收。** 安装包不附带模型服务账号、API Key、模型权重或 Docker 服务镜像。

## 四个实验室

| 实验室 | 实验对象 | 可以做什么 |
| --- | --- | --- |
| Agent Lab | DSH、Codex、Pi、Kimi Code、Qwen Code、Claude Agent | 在本地工作目录对话、运行工具、查看文件变更与产物，测试不同 Harness 的实际行为 |
| Remote Agent Lab | OpenHands、OpenClaw | 自部署服务，上传文件、执行远端任务、观察浏览器或桌面，查看终端和预览、下载产物 |
| Local Model Lab | Ollama 与不同开源模型 | 下载、暂停、续传、删除模型；单模型对话与双模型对照 |
| JEV Lab | TypeSafe JEV 决策 API | 象棋、智能体审核、客户行动、发票分流四类决策实验 |

### Agent Lab

<p align="center"><img src="assets/screenshots/harness-runtimes.jpg" width="1080" alt="六种本地 Harness 的独立入口" /></p>

- 六个独立入口、连接设置和会话空间；不读取你全局安装的 Codex 或 Claude Code 来冒充内置运行时。
- 增量对话、工具动作、结果与产物；文件变更以红绿 Diff 展示，不仅展示原始 JSON。
- 原生审批选项与用户提问；“始终允许”以实际提供的授权范围为准，不代表允许所有操作。
- 多会话、并行执行、最近删除与恢复；输入方式按会话保存。
- **Queue**：为当前工作结束后的下一轮保存消息。**Steer**：通过对应 Harness 的接入机制中途补充。两者不是同一个发送时机。
- 多行输入、Shift + Enter 换行、运行与动作耗时、跨日会话时间展示。

### Remote Agent Lab

OpenHands 与 OpenClaw 使用独立服务、配置和数据卷，不强行抹平能力差异。

- **OpenHands**：浏览器观察、执行过程、终端、文件和产物预览。
- **OpenClaw**：可观察、可操作的远端桌面，包含 Chrome、终端、文件管理器与回收站。
- 文件通过上传/下载交换；远端任务不使用客户端的本地工作目录。
- 服务管理面板可以查看状态、启动、停止服务；任务输入队列与模式由服务端持久化。
- 图片、文本/代码、HTML、PDF 可预览；`.doc/.docx`、`.xls/.xlsx`、`.ppt/.pptx` 经隔离的办公文档渲染服务转换后预览。不支持的格式仍可下载。

桌面里的人工终端与外部终端是同一人工 Shell 的不同入口；智能体命令记录独立展示，不假装所有命令都运行在这个 Shell 内。关闭客户端只断开观察，不自动停止远端服务或任务。

### Local Model Lab

内置固定版本的官方 Ollama 运行时，不要求另装系统 Ollama。模型目录支持安装、下载进度、暂停/继续、取消后重试、已安装模型管理；可在 Playground 中对话，或用同一提示进行双模型对照。

模型权重首次使用时下载，保存在应用配置指定的目录中，不入 Git，也不随安装包分发。GGUF 的可运行性取决于实际模型架构与 Ollama 支持，并非所有 GGUF 都能运行；模型还各自有硬件需求和许可。

### JEV Lab

JEV 不是另一个聊天 Harness，而是远端决策服务。四个实验用于观察候选选择、置信度、概率、耗时与决策结果。

象棋支持人类执红、自对弈、单步、自动/暂停、重开与合法着校验。**没有 JEV 连接时仍能出现棋局或规则回退，不代表正在调用 JEV。** API 失败会明确标记本地规则回退并停止自动对弈，不把回退伪装成模型结果。

## 快速开始

先克隆或下载这个仓库，在**项目根目录**执行命令。

### 1. 准备环境

- 推荐 **Node.js 24 LTS**，最低 `22.19.0`，以及随 Node 安装的 npm。
- Git、curl、tar。Windows 使用 Git for Windows；Linux 还需要 zstd 解压 Ollama。
- 需要访问 npm registry、GitHub Releases；下载模型时还可能访问 Ollama/Hugging Face。
- Rust 仅在自行编译 Codex 时需要；Docker 仅在使用远端实验室时需要。
- 少数原生 npm 依赖没有匹配预编译包时，node-gyp 还需要 Python 3 与本平台 C/C++ 工具链。这是上游依赖需求，不是桌面业务栈改为 Python。

```bash
npm ci
npm run doctor
npm run prepare:runtimes
npm run dev
```

`npm ci` 按锁文件安装依赖、准备 DSH，并校正 Pi 的发行依赖；`prepare:runtimes` 继续准备 Kimi、Qwen、Claude 与 Ollama，Pi 随主项目依赖安装。首次会下载较大的官方运行包，请预留时间和磁盘空间。项目使用按版本限定的安装脚本许可，不需要全局放开所有依赖脚本。

此时可体验已准备的实验室。**Codex 需要下面的源码编译步骤；远端实验室需要下面的 Docker 镜像步骤。** `npm run dev` 不会暗中为你进行一次长时间 Codex 编译。

### 2. 配置连接

进入对应工作区右上角设置，填写接口地址、模型 ID 与 API Key。已保存的设置可以再次修改；服务支持模型目录时可获取模型列表。支持某种请求协议，不等于任意模型都能发挥该 Harness 的全部能力。

| 本地 Harness | 当前接入方式 | 当前模型连接 |
| --- | --- | --- |
| DSH | 独立 Node 运行时，ACP | DeepSeek 兼容接口 |
| Codex | 自行源码编译的 app-server | OpenAI Responses API |
| Pi | 进程内 Agent SDK | DeepSeek 兼容 Chat Completions |
| Kimi Code | 独立 Node 运行时，ACP | OpenAI 兼容 Chat Completions |
| Qwen Code | 独立 Node 运行时，ACP | OpenAI 兼容 Chat Completions |
| Claude Agent | 官方 Agent SDK + 独立可执行文件 | Anthropic Messages API |

服务商、协议、模型与 Harness 是不同概念。例如，提供 Chat Completions 的连接未必提供 Codex 所需的 Responses API。Claude Agent 不会直接套用 DeepSeek 的普通接口。JEV 在自己的设置中配置 TypeSafe 连接；Ollama 本地推理无需云端模型 Key。

## Codex 源码编译

Codex 的大型二进制不提交到 Git，也不从开发者电脑的全局安装中复制。构建清单锁定 [官方源码](https://github.com/openai/codex)、提交与依赖版本。

```bash
rustup toolchain install 1.95.0 --profile minimal
npm run doctor -- --scope codex
npm run build:codex -- --jobs 2
npm run verify:codex
```

平台工具链要求：

- **macOS**：Xcode Command Line Tools；尚未安装时运行 `xcode-select --install`。
- **Windows x64**：Visual Studio 2022 C++ Build Tools 与 Windows SDK，在 x64 Developer PowerShell 中运行编译命令。
- **Linux/glibc**：C/C++ 编译器、pkg-config、OpenSSL 开发包。Debian/Ubuntu 可用 `sudo apt-get install build-essential pkg-config libssl-dev zstd`。

首次编译可能需要数十分钟与数十 GB 缓存空间；`--jobs 2` 用于控制内存占用，可按设备调整。之后复用 Cargo 缓存。

构建包含 **Codex CLI + Code Mode host + ripgrep**，Linux 还包含 bwrap，Windows 还包含 command runner 与 sandbox setup。不会为省事而缺少 Code Mode host 或静默降级。

V8 archive 与 Rust binding 使用上游官方发布构建同款、固定校验值的依赖；Codex 和 host 本身仍从源码编译。上游标签中工作区版本与 Cargo.lock 不一致的部分，只做确定性的本地工作区版本校正，第三方依赖保持 `cargo --locked` 校验。

源码、V8 与编译缓存集中在项目 `.cache/`；生成的布局元数据、文件哈希和编译记录留在 `runtimes/codex/` 的 Git 忽略项中。校验失败时停止打包，不能用别的平台二进制凑数。

只看计划而不编译：`npm run build:codex -- --plan`。同时准备并按需编译 Codex：`npm run prepare:runtimes -- --codex`。

## 服务端部署

### 1. 构建固定源码镜像

Mac/Windows 使用运行中的 Docker Desktop，Linux 可使用 Docker Engine，运行 **Linux 容器**。建议至少给 Docker 8 GB 内存；两套浏览器环境同时运行或构建时可能需要更多。

```bash
npm run doctor -- --scope remote
npm run remote:build -- openhands
npm run remote:build -- openclaw
```

构建脚本会获取对应的固定上游源码，构建原生服务，再应用仓库内的部署层和扩展。办公文档预览使用固定镜像与 digest，无需你在宿主机安装 Python、LibreOffice、Chrome 或 Linux 桌面。

想先查看源码或构建计划：

```bash
npm run remote:source -- openhands --source sdk
npm run remote:source -- openclaw
npm run remote:build -- openhands --plan
npm run remote:build -- openclaw --plan
```

`--plan` 不构建镜像，但首次仍会获取和校验源码。OpenHands 的实际执行服务基于 **Software Agent SDK**；锁文件中的完整 OpenHands app 是可选参考，不是必须构建的第二套后台 UI。

### 2. 在应用中启动

进入 Remote Agent Lab → 服务管理，启动需要的服务，再进入对应工作区设置模型连接。客户端与研发服务的身份凭据自动生成，不需要额外做一套注册登录。

默认服务仅绑定 `127.0.0.1`，不把宿主机工作目录挂进远端任务。配置、会话、上传文件与产物保存在应用专属 Docker 数据卷中。**停止容器不等于删除数据；删除数据卷会丢失服务端数据。** 不要为排障直接清空 Docker volumes。

这是单个本机研发实例的部署方式，不是可直接开放公网的多用户 SaaS。公开部署还需要独立的认证、TLS、用户隔离、配额、运维与安全设计。

## 桌面打包

运行时准备完毕后，在**目标操作系统和目标 CPU 架构的原生环境**打包。脚本会拒绝把 Mac 的运行包塞进 Windows/Linux 安装包。

```bash
# 当前平台的正式分发格式
npm run package

# 分别在对应平台执行
npm run package:mac
npm run package:win
npm run package:linux

# 只生成可运行目录，便于本机测试
npm run package:dir
```

| 目标 | 默认分发格式 | 验证状态 |
| --- | --- | --- |
| macOS Apple Silicon | DMG + ZIP | 本机源码编译、打包和界面已验收 |
| macOS Intel | DMG + ZIP | 原生构建配置/CI 已准备，待实机验收 |
| Windows x64 | NSIS 安装程序 | 原生构建配置/CI 已准备，待实机验收 |
| Linux x64 / glibc | AppImage | 原生构建配置/CI 已准备，待实机验收 |

Windows/Linux ARM64 有运行时恢复路径，但不在当前默认发布矩阵内，不作为已经验收的平台承诺。

产物统一放在 `release/`。本机 Mac 输出示例：

```text
release/
├── mac-arm64/Agent Lab.app
├── Agent-Lab-0.1.0-mac-arm64.dmg
└── Agent-Lab-0.1.0-mac-arm64.zip
```

应用图标统一来自 `assets/brand/agent-lab-app-icon.png`；打包器转换为 macOS ICNS、Windows ICO 与 Linux 图标尺寸，窗口图标也使用这份资产。分发包包含对应平台的本地运行时，但不含个人配置、会话、模型权重或容器镜像。

**当前包未配置 macOS 签名/公证和 Windows 代码签名，也没有自动更新或自动发布。** 系统可能提示来源无法验证。请先核对仓库与构建来源，再按系统正常流程判断是否允许运行；不要为运行本项目全局关闭系统安全保护。

`.github/workflows/check.yml` 在三种系统执行源码检查、类型检查、测试和构建；`package.yml` 手动触发四种原生打包，只上传 CI 验证产物，不发布 GitHub Release。首次将仓库推送到 GitHub 后仍需观察这些 CI 的实际结果。

## 架构与目录

```text
Electron 桌面应用
├── 本地适配器 → 内置 Harness / Pi SDK → 所选本地工作目录
├── HTTP / WebSocket → OpenHands、OpenClaw 服务 → 服务端任务与文件
├── LocalModelService → Ollama → 本机模型目录
└── JEV 实验 → TypeSafe 远端决策 API
```

```text
apps/desktop/
├── src/main/                 窗口、IPC、SQLite、凭据、运行时与服务管理
├── src/preload/              渲染进程的受控桌面接口
├── src/renderer/             应用壳和四个实验室
└── electron-builder.yml      多平台分发与图标配置
packages/
├── contracts/               共享类型与交互契约
├── runtime/                 六种 Harness 适配器、审批/提问/消息桥接
└── remote-agent/            服务通信、模型设置、任务、文件与预览
services/remote-agent/
├── openhands/               源码锁、部署层、扩展和验证
├── openclaw/                源码锁、部署层、桌面和验证
└── document-preview/        办公文档转换服务
runtimes/                    固定运行时清单、许可与接入加载器
scripts/                     环境检查、恢复、编译、校验、打包与服务脚本
assets/                      品牌、背景与 README 实机截图
.github/workflows/           检查与原生打包 CI
.cache/ / .work/ / release/  缓存、临时验证与构建产物，不入 Git
```

Renderer 不直接读取密钥或执行系统命令。窗口启用 sandbox、context isolation，关闭 Node integration；桌面能力通过 preload 的窄接口与主进程收口。

## 数据与安全

### 个人数据不在安装包内

新安装的默认应用数据目录：

| 系统 | 目录 |
| --- | --- |
| macOS | `~/Library/Application Support/Agent Lab/` |
| Windows | `%APPDATA%\Agent Lab\` |
| Linux | `$XDG_CONFIG_HOME/Agent Lab/`，未设置时通常为 `~/.config/Agent Lab/` |

其中包含 `agent-sessions.sqlite`、`local-model-runs.sqlite`、应用/模型配置 JSON、加密连接设置、`runtime-homes/` 和默认本地模型目录。SQLite 保存应用会话与实验记录；Harness 还在自己的 runtime home 中维护原生上下文，不是每次把整个 SQLite 历史重新拼成提示词。

已有旧版安装会继续兼容旧数据目录与加密身份，可能仍显示 `SelfMe Lab` 路径。这用于保护旧会话、系统密钥与 Docker 卷关联，不是遗漏改名。不要直接移动该目录或从一个系统复制加密设置到另一个系统。

### 凭据与执行边界

- 应用保存的本地连接 Key、研发服务认证凭据使用 Electron 系统凭据加密；不提供内置免费 Key。Linux 需要可用的 Secret Service/KWallet，缺失时拒绝保存，不回退为弱加密。
- 模型请求由你配置的服务商处理，可能产生费用。远端模型配置保存在对应服务的私有数据卷内；不是从客户端安装包提供账号。
- 工作目录是任务范围，**不等于所有工具都拥有强安全沙箱**。允许执行命令后，部分 Harness 的命令仍可能访问目录外或网络；请用可恢复的测试项目，不直接授权处理敏感生产数据。
- 远端环境使用容器/任务工作区隔离；本机开发服务不是对抗恶意租户的安全边界，不应直接暴露公网。
- 提交日志、截图、数据库或 Issue 前，请删除 API Key、个人路径、任务内容与私密文件。

### 依赖审查范围

2026-10-14 已检查主项目和三个独立 Node 运行时的生产依赖，并修正 MCP SDK、brace-expansion 和 sharp 的已知公告项。Pi 发行包内部的 shrinkwrap 会优先于外层锁文件，因此恢复脚本从官方 registry 下载、校验并安装固定的 brace-expansion `5.0.12`；Qwen 固定使用 sharp `0.35.5`，不因此更换 Harness 版本。更新锁文件后还需验证实际安装文件，不能只看审计数字。

**开发工具链仍有上游审计项，未通过强制升级打包器来消除。** npm 审计也不涵盖闭源可执行文件、Rust/Cargo 的全部依赖或容器系统软件，不代表项目没有安全风险。维护时定期检查四棵依赖树：

```bash
npm audit --omit=dev
npm audit --prefix runtimes/dsh --omit=dev
npm audit --prefix runtimes/kimi-code --omit=dev
npm audit --prefix runtimes/qwen-code --omit=dev
```

对应公告：[MCP OAuth 凭据保护](https://github.com/advisories/GHSA-6qxp-vccf-f47h)、[brace-expansion](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)、[sharp/librsvg](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)。开发依赖请另运行不带 `--omit=dev` 的审计并逐项评估，不使用 `npm audit fix --force` 盲目升级。

## 提交什么，忽略什么

| 应提交到 GitHub | 不应提交 |
| --- | --- |
| 桌面/适配器/服务端代码与测试 | `node_modules/`、可执行文件和原生库 |
| package.json 与所有 package-lock.json | `.cache/`、`.work/`、构建目录与安装包 |
| 上游版本、commit、校验值与恢复脚本 | `upstream/` 下载源码缓存 |
| Dockerfile、部署层与服务扩展 | Docker 卷、会话、上传文件、模型权重 |
| 实际品牌资产、必要展示图、许可证与 README | 个人配置、API Key、`.env`、SQLite 数据库 |

忽略项中的依赖、源码缓存与运行时产物可以通过脚本恢复；**个人会话、密钥、自己下载的模型与远端数据卷不是源码的一部分，不能靠 Git 恢复。** 安装包作为独立分发产物发布，不提交进仓库历史。

## 验证与贡献

```bash
npm run typecheck
npm test
npm run test:scripts
npm run test:remote
npm run check:source
```

默认测试不依赖付费模型；需要真实运行包或 Docker 的集成测试默认跳过，跳过不代表验收完成。当前已单独验证：新克隆依赖/运行时恢复、Codex 全新源码编译、本地 Harness 的真实工具与会话交互、两套原生容器及办公文档渲染、Mac 安装包界面。

真实 Harness 与容器测试使用临时工作区、测试身份和本地模拟模型服务，相关开关见各 `*.integration.test.ts`。例如，已准备运行时后可执行：

```bash
# macOS / Linux；Windows PowerShell 请先设置对应环境变量
AGENT_LAB_STEERING_INTEGRATION=1 npm run test --workspace @agent-lab/desktop -- packages/runtime/src/user-questions.integration.test.ts
AGENT_LAB_REMOTE_INTEGRATION=1 npm run test --workspace @agent-lab/desktop -- apps/desktop/src/main/remote-agent/service-manager.integration.test.ts
```

`check:source` 检查常见凭据和误提交的生成/个人文件，但不能替代人工审核或专用秘密扫描。更新上游版本时，请同步锁文件、脚本许可、加载器约束、第三方通知与真实集成验收，不只改一个版本字符串。

贡献请先围绕一个可复现问题或明确实验目标展开。提交复现步骤、平台/版本、脱敏日志与预期行为，避免把实验平台扩成未经验证的能力清单。

## 常见问题

**需要先安装 Codex、Claude Code、Ollama 吗？**

不需要全局安装。源码运行需要先恢复项目运行时；分发包已经带上对应本地运行时。API 连接和模型权重仍需自己准备。

**为什么第一次启动准备很慢？**

可能正在下载官方运行包。首次 Codex 编译、Docker 镜像构建和模型权重下载都比较大，它们是不同步骤。脚本保留项目内缓存以便重试；不会擅自改代理或 DNS。

**“Codex 尚未准备”怎么办？**

运行 `npm run doctor -- --scope codex`，按提示补齐工具链，再执行 `npm run build:codex` 与 `npm run verify:codex`。不要复制其他架构的二进制，也不要省掉 Code Mode host。

**桌面包能独自启动远端实验室吗？**

包里是客户端，不包含巨大的服务镜像。先在同机 Docker 中按“服务端部署”构建镜像，然后从应用启动。这里的“远端”描述执行边界，即使研发服务部署在本机，任务仍在服务端容器执行。

**能直接做公网、多用户、移动端服务吗？**

当前没有提供生产级公网部署或多租户保障。可以在此基础上研发，但不能把本机自动认证、私有卷和回环地址配置直接当作生产方案。

**所有模型/Harness 的 Skills、MCP、插件都已统一了吗？**

没有。当前验证的是已接入的实际交互，不承诺复刻每家发行产品附带的扩展生态或实现全部原生 UI。

## 许可证与致谢

Agent Lab 原创代码采用 [Apache License 2.0](LICENSE)。第三方软件、模型、商标与服务保留各自许可和条款，详见 [第三方通知](THIRD_PARTY_NOTICES.txt) 与 [NOTICE](NOTICE)。

特别注意：**Claude Code 可执行文件并不是开源组件**，来自官方 Agent SDK 平台包，适用 [Anthropic SDK 条款](https://code.claude.com/docs/en/agent-sdk/overview#license-and-terms) 与 [法律/合规说明](https://code.claude.com/docs/en/legal-and-compliance)；本项目的 Apache 许可不能替代它们，也不授予第三方模型或服务的使用资格。

感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[Codex](https://github.com/openai/codex)、[Pi](https://github.com/earendil-works/pi)、[Kimi Code](https://github.com/MoonshotAI/kimi-code)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[OpenHands SDK](https://github.com/OpenHands/software-agent-sdk)、[OpenClaw](https://github.com/openclaw/openclaw)、[Ollama](https://github.com/ollama/ollama) 与其他依赖的维护者。本项目独立开发，不代表上述厂商的官方产品。
