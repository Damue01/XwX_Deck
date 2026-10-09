# 原生运行时迁移导读

参考实现保留 React 界面，将运行时后端与外壳移到 Rust / Tauri。按能力迁移到其他项目时，应先列出目标项目的产品范围、现有用户数据、身份和更新渠道；页面缺失不代表应删除目标功能。迁移保持目标项目独立历史、应用身份、数据路径和端口。

## 代码入口

| 能力 | 入口 |
| --- | --- |
| 桌面生命周期、窗口、托盘、权限与 IPC | `src-native/src/main.rs` |
| 配置、模型服务、接管账本、迁移、修复和退出恢复 | `src-native/src/core.rs` |
| 协议转换、流式消息与续接 | `src-native/src/protocol.rs` |
| Trace JSONL、索引、用量、保留与手动修复 | `src-native/src/storage.rs` |
| 多账号授权、凭据、额度与轮换 | `src-native/src/subscriptions.rs` |
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
npm run compile
npm run test:built
npm run test:upstream
npm run check:public-boundary
npm run check:workflows
npm run docs:build
npm run build:rust:pilot
npm run test:rust
```

`test:rust:backend` 包含协议、服务预设、API 导入、订阅授权与策略、历史元数据、字段冲突、退出恢复、Trace 修复、迁移、客户端、语言和更新检查。`native-test.mjs` 使用实际系统 WebView 和真实后端请求。Windows 的物理更新测试只在原生 Windows 运行；Mac 不能替它给出通过结论。

当前订阅及协议转换使用 HTTP SSE；转换 WebSocket、无本地来源的不透明状态和未提供可信用量的服务均保留明确边界。旧 TypeScript 保留部分测试与资源生成作用，不应在对照验收完成前整体删除。
