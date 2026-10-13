# 运行架构

XwX Deck 使用 Rust 和 Tauri 运行。
前端使用 React、TypeScript 和 Tailwind CSS。
组件统一使用 Base UI/COSS。
发行包使用系统 WebView。

## 源码职责

| 目录 | 职责 |
| --- | --- |
| `src-native` | 配置、账号、Gateway、协议、Trace 和更新。 |
| `src/renderer` | 模型、设置、仪表盘和请求详情界面。 |
| `src/shared` | 浏览器格式、类型及模型参考数据。 |
| `tools/build` | 前端样式和原生资源生成。 |
| `tools/native` | 原生构建及隔离回归。 |

旧 TypeScript 后端已移除。
默认依赖不包含 Electron。
Node.js 仅用于开发、构建与测试。
文档使用 VitePress 构建。
这些开发工具不进入应用运行环境。

## 身份与数据

应用 ID 为 `app.xwxdeck.desktop`。
配置目录名为 `xwx-deck`。
Gateway 端口为 `45233` 至 `45242`。
新安装不预置 API 服务。
已有配置和外部修改按所有权保护。

每条请求保留原始数据与价格快照。
会话身份以客户端原生标识为准。
请求详情按需读取，摘要分页加载。
已知金额正常显示，缺项单独提示。

## 公开范围

保留模型、账号、Trace 与会话历史管理。
保留安全停止、索引修复和增强功能。
跨服务切换默认关闭。
公开版不提供工具页或客户端配置同步。
范围以 [公开边界](public-release-boundary.md) 为准。

## 验证与交付

执行 `npm run check:quality` 验证当前源码。
执行 `npm run check:public-boundary` 检查公开边界。
检查使用隔离配置与合成上游。
真实服务及各平台操作另行验收。

源码推送不包含安装或发布。
更新继续使用公开 GitHub Releases。
macOS 保留手动 DMG 更新流程。
