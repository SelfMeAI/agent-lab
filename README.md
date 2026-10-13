# SelfMe Lab

SelfMe Lab 是 Electron + TypeScript 桌面实验平台，只保留四个已实现的实验室：Agent Lab、Remote Agent Lab、Local Model Lab 和 JEV Lab。首页提供四个独立入口，各实验室保留自己的工作区、配置和测试场景。

## 运行与验收

需要 Node.js 22.12+，当前打包目标为 macOS Apple Silicon。

```bash
npm install
npm run dev
npm run typecheck
npm test
SELFME_DSH_SMOKE=1 npm test
```

`npm install` 会把固定版本 DSH 安装在本项目的 `runtimes/dsh/` 内。Codex 是官方源码构建的本地运行时，不能依赖用户电脑上安装的 Codex；其大型可执行文件不入 Git。新克隆仓库如需运行或打包 Codex，需在此仓库执行一次 `npm run build:codex`。该命令使用固定的官方 Codex 与 rusty_v8 提交，首次编译需要 Git、Rust/Cargo、较长时间和充足磁盘空间，源代码与构建缓存只在项目的 `.cache/`；运行 `npm run verify:codex` 校验版本、包布局与哈希。已准备运行时后：

```bash
npm run package:mac
```

打包结果位于 `release/mac-arm64/SelfMe Lab.app`。当前包未签名、未公证，不是对外发布包；打包版包含 DSH、Codex CLI、Code Mode host 与 ripgrep，不要求用户另行安装这些运行时。

## 四个实验室

- Agent Lab：接入 DSH、Codex、Pi、Kimi Code、Qwen Code 和 Claude Agent。选择本地工作目录，配置适合各 Harness 的模型协议、地址、模型 ID 与 API Key；可查看增量消息、工具动作、文件变更与产物，处理审批、提问、取消、多个会话及 Queue / Steer。Codex 使用项目内从官方源码构建的 app-server。
- Remote Agent Lab：接入自部署的 OpenHands 与 OpenClaw。任务、文件和模型配置在服务端；客户端通过接口提交消息、上传资料、查看执行过程并预览或下载产物。OpenHands 提供浏览器观察，OpenClaw 提供可操作的远端桌面；两套服务支持终端、文件、预览及服务端持久化的 Queue / Steer。
- Local Model Lab：使用项目内的 Ollama 运行时，提供模型目录、下载/暂停/续传、已安装模型管理、对话和双模型对照。模型文件按本机配置保存，不随源码或安装包分发。
- JEV Lab：包含象棋、智能体审核、客户行动和发票分流决策实验。在设置中配置 TypeSafe JEV API。象棋支持人类执红 vs JEV、红黑自对弈、单步、自动/暂停、重开、合法着校验、决策指标、候选概率和棋谱。API 不可用时只执行一次明确标记的本地规则回退，自动对弈会停止，绝不把回退标成 JEV 在线结果。

本地 Harness 与 JEV 的 API Key 通过 Electron 系统凭据加密能力保存在本机应用数据目录，不写入仓库、工作目录或渲染进程。远端模型连接由对应服务保存；客户端与研发服务之间的认证凭据自动生成并加密保存在本机。设置可以再次打开修改。

## 服务端本地部署

需要安装并启动 Docker Desktop。两套服务使用固定版本的官方源码与仓库内的部署层，新克隆仓库需分别构建镜像：

```bash
npm run remote:build -- openhands
npm run remote:build -- openclaw
```

构建脚本会获取锁定的上游源码，并准备办公文档预览镜像。完成后进入 Remote Agent Lab 的服务管理面板，启动所需服务并配置模型连接。关闭桌面应用不会停止容器；任务、配置和文件保存在独立 Docker 数据卷中。

## 结构

```text
apps/desktop/src/main/       Electron 窗口、IPC、加密配置、JEV 决策请求
apps/desktop/src/preload/    渲染页面与主进程之间的窄接口
apps/desktop/src/renderer/   应用壳、导航与实验室页面
packages/contracts/         进程间共享类型
packages/runtime/           六种本地 Harness 的适配器与交互桥接
packages/remote-agent/      远端任务、模型连接、文件与通信客户端
services/remote-agent/      固定上游版本、部署层、扩展及办公文档预览服务
runtimes/dsh/               固定版本 DSH 清单；node_modules 不入 Git
runtimes/codex/             Codex 来源记录、许可和包元数据；大型二进制不入 Git
scripts/                    运行时准备、源码构建和校验
assets/                     应用实际使用的品牌图与背景
design/                     已确认设计稿、视觉约束与提示词
.cache/、.work/、release/    本地缓存/测试/打包产物，不入 Git
```

Renderer 不直接访问文件系统或密钥；桌面调用通过 `DesktopBridge` 和主进程收口。研发阶段的远端服务部署在本机 Docker 中，但任务仍在服务端执行，不使用客户端本地工作目录。保留的工作区设计稿用于风格参考，不是功能完成证明；首页以当前四入口实现为准，每个真实能力都要以打包版的交互和产物验收。
