# SelfMe Lab

SelfMe Lab 是 Electron + TypeScript 桌面实验平台。当前可实际运行的模块：Agent Lab 的 DSH 与 Codex、本机 JEV Lab 的象棋观测台。其他入口是明确标记的后续实验，不会展示虚构结果。

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

## 已接入能力

- DSH：在 Agent Lab → DSH 选择工作目录，右上角配置 DeepSeek 官方或兼容接口根地址与 API Key。自动连接后可发送任务、看增量输出与工具详情、处理审批和取消。
- Codex：在 Agent Lab → Codex 使用项目内从官方源码构建的 app-server。设置支持 Responses 兼容根地址、模型 ID 和 API Key。可看增量消息、命令/文件变更和审批；工作区外操作会等待人工批准。
- JEV：在 JEV Lab → Xiangqi 配置 TypeSafe JEV API。可玩人类执红 vs JEV，或 JEV 红黑自对弈；支持单步、自动/暂停、重开、合法着校验、决策指标、候选概率和棋谱。API 不可用时只执行一次明确标记的本地规则回退，自动对弈会停止，绝不把回退标成 JEV 在线结果。

三套密钥分别通过 Electron 系统凭据加密能力保存在本机应用数据目录，不写入仓库、工作目录或渲染进程。设置可以再次打开修改。

## 结构

```text
apps/desktop/src/main/       Electron 窗口、IPC、加密配置、JEV 决策请求
apps/desktop/src/preload/    渲染页面与主进程之间的窄接口
apps/desktop/src/renderer/   应用壳、导航与实验室页面
packages/contracts/         进程间共享类型
packages/runtime/           Harness 适配器、DSH ACP、Codex app-server
runtimes/dsh/               固定版本 DSH 清单；node_modules 不入 Git
runtimes/codex/             Codex 来源记录、许可和包元数据；大型二进制不入 Git
scripts/                    运行时准备、源码构建和校验
assets/                     应用实际使用的品牌图与背景
design/                     已确认设计稿、视觉约束与提示词
.cache/、.work/、release/    本地缓存/测试/打包产物，不入 Git
```

首阶段没有云端后端。Renderer 不直接访问文件系统或密钥；桌面调用通过 `DesktopBridge` 和主进程收口。设计稿是界面依据，不是功能完成证明；每个真实能力都要以打包版的交互和产物验收。
