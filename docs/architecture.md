# 架构与维护

## 主链路

`Renderer -> preload IPC -> XwXDeckController -> Gateway helper -> upstream`

- Renderer 只通过 preload 暴露的窄 API 操作主进程。
- Controller 管理客户端配置、Trace 状态、模型目录和 Gateway 生命周期。
- 独立 Gateway helper 在管理器关闭后仍可继续转发，并通过构建 ID 与协议版本拒绝错误附着。
- TraceStore 保存本地请求、响应和会话索引。
- `applicationReset.ts` 负责有边界的缓存修复和应用重置；`exitRecovery.ts` 在强制退出兜底路径中先恢复客户端配置，再终止 Gateway 与管理器。
- 价格与用量链路在请求落盘时记录分档、峰谷时段和实际服务模型名，Viewer 只聚合这些可验证数据，不对缺失分桶静默猜价。

## 独立版边界

| 项目 | 值 |
|---|---|
| appId | `app.xwxdeck.desktop` |
| userData | `xwx-deck` |
| Gateway 端口 | `45233-45242` |
| 配置同步 | 不包含 |
| 工具页 | 仅本地只读的 ChatGPT 对话诊断 |
| 默认更新服务 | 不配置 |

## 改动检查

1. 修改 IPC 时同步更新 preload、共享类型、预览 API 和 smoke。
2. 修改 Gateway 时验证 helper 升级、活动请求、续接、配置恢复和客户端重新附着。
3. 修改 Renderer 时运行真实浏览器/Electron 交互检查，并确认控制台无错误。
4. 公共构建前运行 `npm run check:public-boundary`。
