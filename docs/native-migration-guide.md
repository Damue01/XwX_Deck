# 原生运行时迁移导读

当前公开版保留 React 界面。
后端与桌面外壳统一使用 Rust / Tauri。
复用代码前，先核对目标项目的产品范围和用户数据。
页面缺失不代表应删除目标功能。
目标历史、身份、数据路径、端口和更新渠道分别保留。

## 代码入口

| 能力 | 入口 |
| --- | --- |
| 桌面生命周期、窗口、托盘、权限与 IPC | `src-native/src/main.rs` |
| 配置、模型服务、接管账本、迁移、修复和退出恢复 | `src-native/src/core.rs` |
| 协议转换、流式消息与续接 | `src-native/src/protocol.rs` |
| Trace JSONL、索引和手动修复 | `src-native/src/storage.rs` |
| 会话身份和辅助请求 | `src-native/src/conversation_identity.rs`、`src-native/src/trace_classification.rs` |
| 用量归一化与每请求费用快照 | `src-native/src/trace_usage.rs`、`src-native/src/trace_pricing.rs` |
| 服务目录和公共能力来源 | `src-native/src/catalog.rs`、`src-native/src/model_metadata.rs` |
| 多账号授权、额度与轮换 | `src-native/src/subscriptions.rs`、`src-native/src/subscription_routing.rs` |
| 凭据保护 | `src-native/src/credentials.rs` |
| 明确启用的跨服务切换 | `src-native/src/service_switching.rs` |
| 外部 API 配置的预览与导入 | `src-native/src/config_import.rs` |
| 客户端发现与显式标签管理 | `src-native/src/client_installations.rs` |
| 原生 Windows 便携更新 | `src-native/src/portable_update.rs` |
| 系统语言及保存后的语言选择 | `src-native/src/language.rs`、`src/renderer/lib/i18n.ts` |
| 原生构建、资源压缩和安装包验证 | `tools/native/` |

## 验收约束

- 用户最后一次明确的服务、模型、容量、清理、语言和客户端选择持久化；目录离线不撤回选择。
- 外部配置变化必须保留并提示，切换及恢复仅处理自己拥有的字段。备份和失败恢复可追溯。
- 普通切换默认新请求使用新服务，活动请求保持原快照；跨协议转换不能重试已经输出的请求。
- 续接需要真实内容或可恢复的来源状态，不透明外部压缩无法还原时明确失败。
- 每类订阅只出现一个模型服务，内部多账号默认参与，保留会话亲和。额度未知不猜测；只有可信官方额度才启用相应策略。
- 修复和删除仅由用户发起；超高风险确认，中低风险 Toast。显示忙碌与完成反馈，保持表单草稿，不以整页快照阻塞操作。
- 导入先预览，来源文件只读，忽略已存在项，同名不同连接另存，检测来源和目标漂移，失败回滚。账号授权凭据不当普通 API Key 导入。
- 全新配置没有默认服务连接，先检测可迁移配置，再引导首次请求。
- 测试使用独立目录和本地 HTTP / SSE / WebSocket 服务。实际模型请求、原生界面、安装包与公开更新源分别留证。

## 检查入口

```bash
npm run check:quality
npm run check:public-boundary
npm run check:workflows
npm run docs:build
npm run build:native:isolated
npm run test:native:webview
```

`test:native:backend` 验证隔离后端。
覆盖配置、协议、账号、历史、恢复、存储和更新。
`native-test.mjs` 使用系统 WebView 和实际 Rust 后端。
WebView 是系统提供的网页渲染组件。

物理 Windows 更新只在原生 Windows 验证。
macOS 不能替 Windows 给出通过结论。

HTTP SSE 与 WebSocket 按实际入口分别验证。
无本地可读来源的不透明上下文不能强行恢复。
缺少可信用量时，记录未计价原因。

TypeScript 只用于前端、共享格式和开发工具。
默认构建不包含第二套后端、Node 或 Chromium。
macOS 公开版只下载并校验 DMG，最终安装由用户手动完成。
迁移源码、构建候选和通过回归不等于安装或公开发布。
