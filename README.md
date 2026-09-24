# SelfMe Lab

SelfMe Lab 是一个可扩展的桌面实验平台。当前仓库是 **Electron + TypeScript 框架阶段**：可启动的桌面壳、实验室导航、设计资产、进程通信契约和运行时适配器接口已经建立；Codex、DSH、Pi、JEV 等真实实验能力仍待逐项接入。界面会明确显示未接入状态，不把设计稿中的样例数据当成真实运行结果。

## 本地运行

需要 Node.js 22.12+。在仓库根目录运行：

```bash
npm install
npm run dev
```

检查与打包：

```bash
npm run typecheck
npm test
npm run build
npm run package:mac
```

`package:mac` 会把 macOS 应用输出到 `release/`，不会发布或签名。

## 目录

```text
apps/desktop/       Electron 主进程、preload、React 界面
packages/contracts/ 进程之间共享的 TypeScript 类型
packages/runtime/   Harness 适配器接口和注册表
assets/             应用真正使用的品牌图与背景图
design/catalog.json 已确认设计稿的稳定 ID 和路径索引
design/screens/     按模块归档的 23 张设计稿与对应提示词
design/system/      通用视觉约束
.work/              本地缓存，不入 Git
release/            本地打包结果，不入 Git
```

旧 Tauri/Rust/DSH/Codex 实现和 JEV 项目已移到同级的 `selfme-lab-reference/` 目录作临时参考，**未删除**，也不属于此仓库。真实适配器接入时可以参考原代码，但不得把其编译缓存、凭据或临时产物带回新仓库。

## 边界

- Renderer 只通过窄化的 `DesktopBridge` 访问桌面能力；文件系统与未来的 Harness 调用不直接暴露给页面。
- `packages/runtime` 定义适配器生命周期和事件格式；当前注册表为空，尚无模拟运行时。首个真实适配器接入时再落实独立运行进程与审批流。
- 设计稿是视觉参考，不是实现完成证明；`design/catalog.json` 的 ID 与页面入口由测试校验。
- 首阶段无云端服务。若某个实验需要协同后端，再单独建立 TypeScript 服务，而不是预先塞进桌面进程。
