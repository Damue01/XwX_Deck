# 架构与维护

## 主链路

`React Renderer -> Tauri 原生桥接 -> Rust 后端 -> upstream`

- 原有 React 页面通过窄 API 调用 `src-native/src/main.rs`，远端 Viewer 窗口不能调用配置写入接口。
- `core.rs` 与 `clients.rs` 管理客户端配置、明确选择、字段恢复账本和 Gateway 生命周期。
- `protocol.rs`、`reasoning.rs`、`live.rs`、`websocket.rs` 和 `continuation.rs` 管理协议、SSE、WebSocket 与续接。
- `storage.rs` 保存 Trace 和索引，按实际用量分桶估价；`history.rs` 只在用户发起时归并和恢复历史元数据；`desktop.rs` 管理 Claude Desktop。
- `updates.rs` 校验不可变更新清单、下载大小及 SHA-256，`portable_update.rs` 执行 Windows 原生文件替换。Mac 使用手动 DMG。
- 关闭窗口后 Gateway 留在原生进程中，托盘和 macOS Dock 可重新打开。退出前恢复直连；冲突保留外部修改及账本，崩溃后重试恢复。
- macOS 使用原生标题栏、红黄绿按钮、系统 WebKit / TLS / SQLite。包内没有 Electron、Node 或 Chromium。
- 旧 `src/main` 实现保留为迁移回归对照及构建时资源生成来源，不进入原生发行包。

## 独立版边界

| 项目 | 值 |
|---|---|
| appId | `app.xwxdeck.desktop` |
| userData | `xwx-deck` |
| Gateway 端口 | `45233-45242` |
| 配置同步 | 不包含 |
| 工具页与对话诊断 | 已移除 |
| 默认更新服务 | 独立 GitHub Releases；元数据推送默认关闭 |

## 改动检查

1. 修改原生 API 时同步更新桥接、共享类型、预览 API 和 smoke。
2. 修改 Gateway 时验证活动请求、续接、配置恢复、崩溃恢复和客户端重新附着。
3. 修改 Renderer 时运行实际系统 WebView 交互检查，并确认控制台无错误。
4. 运行 `npm run build:rust:pilot`、`npm run test:rust`；Windows 系统集成需要原生 Windows 主机验证。
5. 公共构建前运行 `npm run check:public-boundary`。
