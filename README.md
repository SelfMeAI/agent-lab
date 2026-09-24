# SelfMe Lab

SelfMe Lab 是一个可扩展的桌面实验平台。当前已接入项目内打包的 DeepSeek Harness（DSH）ACP：可选工作目录、配置模型、发送任务、观察增量输出与工具事件、审批和取消。Codex、Pi、JEV 等仍待逐项接入；未完成的入口不会显示虚构的运行记录。

## 本地运行

需要 Node.js 22.12+。在仓库根目录运行：

```bash
npm install
npm run dev
```

`npm install` 会安装仓库内固定版本的 DSH 到 `runtimes/dsh/node_modules/`。用户运行打包版无需另外安装 DSH 或 Node.js。首次启动开发版时，Electron 二进制也会补到本项目的 `node_modules/`。

检查与打包：

```bash
npm run typecheck
npm test
npm run build
npm run package:mac
```

`package:mac` 会把 macOS 应用输出到 `release/`，不会发布或签名。

在 Agent Lab → DSH 中选择工作目录，并在右上角设置里填写 DeepSeek 官方或兼容 DeepSeek Chat Completions 的中转根地址与 API Key。密钥通过 Electron 的系统凭据加密能力存于本机应用数据目录；不会写入仓库或工作目录。工作目录选定且配置完成后，DSH 自动连接，无需手动点击“启动”。审批选项来自 DSH 本身；工具卡片可以展开查看 ACP 原始详情。

可运行 `SELFME_DSH_SMOKE=1 npm test` 对项目内真实 DSH 做一次无模型密钥的 ACP 启动与错误路径测试。它不能替代有密钥时的完整任务验收。

## 目录

```text
apps/desktop/src/
  main/             Electron 窗口、IPC 与桌面能力
  preload/          渲染页面与主进程之间的窄接口
  renderer/
    app/            应用入口和导航
    shell/          首页、顶栏、设置
    labs/           七个实验室各自的模块入口；Agent Lab 有独立页面
    styles.css      当前共用视觉样式
packages/contracts/ 进程之间共享的 TypeScript 类型
packages/runtime/   Harness 适配器接口和注册表
runtimes/dsh/        固定版本的 DSH 清单与锁文件；node_modules 不入 Git
assets/             应用真正使用的品牌图与背景图
design/catalog.json 已确认设计稿的稳定 ID 和路径索引
design/screens/     按模块归档的 23 张设计稿与对应提示词
design/system/      通用视觉约束
.work/              本地缓存，不入 Git
release/            本地打包结果，不入 Git
```

每个实验室的 `index.ts` 声明自己的名称、分组、子入口、设计稿 ID 和页面组件。公共壳只读取模块注册表，不包含“如果是某个实验室就执行某段逻辑”的分支。目前只有 Agent Lab 需要专属页面；其他实验室仍共用明确标记为待接入的页面。真实能力开发时在相应模块下增加页面和样式，不再把功能堆入应用入口。

旧 Tauri/Rust/Codex 实现和 JEV 项目仍在同级的 `selfme-lab-reference/` 作临时参考，不属于此仓库；当前 DSH 已完全依赖本仓库固定版本的运行时。后续 Codex/JEV 迁移完成且确认无剩余用途后，应清理整个参考目录；不得把旧编译缓存、凭据或临时产物带回新仓库。

## 边界

- Renderer 只通过窄化的 `DesktopBridge` 访问桌面能力；文件系统与未来的 Harness 调用不直接暴露给页面。
- `packages/runtime` 定义适配器生命周期和事件格式；DSH 适配器在独立子进程中通过 ACP 工作。其他运行时仍未接入。
- `host/`、`adapters/` 等执行侧目录尚未建立，因为还没有可运行的实现；接入首个真实能力时按进程边界创建，不使用空目录冒充完成。
- 设计稿是视觉参考，不是实现完成证明；`design/catalog.json` 的 ID 与页面入口由测试校验。
- 首阶段无云端服务。若某个实验需要协同后端，再单独建立 TypeScript 服务，而不是预先塞进桌面进程。
