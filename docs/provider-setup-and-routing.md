# 模型服务配置与切换源码导读

本页记录 2026-10-08 这轮改动，供阅读实现、复现问题和按能力移植时参考。应用版本为 `1.0.0`，源码提交与安装包校验值分别记录在 Git 和本地制品清单中。

## 先看使用结果

- 模型配置分为客户端、官方模型服务和已保存连接。客户端与官方模型服务图标分别可折叠、默认收起，收起不隐藏自定义与已保存连接。七个官方服务入口保留横向滚动，不显示滚动条和左右箭头；「自定义」固定在右上角。普通鼠标悬停在服务栏时，滚轮转换为横向浏览，到两端后释放给页面；触控板横向手势及 Shift＋滚轮保持原生行为，Tab 可自动带出聚焦的服务。
- 官方预设先展示配置卡片，确认后再预填表单；密钥留空，保存才创建连接。自定义及不同预设的未保存草稿分别保留。
- 每个连接分别记住模型和上下文窗口。切换服务时先读同一连接缓存，再刷新目录；远端失败不撤销本地选择。
- Gateway 将其他连接记住的旧模型名映射到当前所选模型，同时保留目标目录中有效的模型和未知手填模型。
- 官方订阅只把模型地址交给 Gateway，账户与工作区地址保持 HTTPS。旧客户端账户请求有单独兼容路由，不计入模型 Trace。
- Trace 新配置默认上限 1 GB 并开启超出上限自动清理；已有明确容量和清理选择保留。索引修复由用户手动检查、确认和执行。
- 退出恢复保留外部配置修改；仍有本地依赖时保留 Gateway，并报告恢复失败。

## 从界面到请求的阅读顺序

| 能力 | 主要源码 | 阅读重点 |
| --- | --- | --- |
| 客户端下载与服务卡片 | `src/renderer/features/settings/ProviderSetupShortcuts.tsx`、`src/shared/setupWebsites.ts`、`src/shared/officialProviders.ts` | 下载入口与 API 预设分开；原生横向滑动、普通滚轮转换、边缘释放与键盘聚焦 |
| 自定义与草稿 | `src/renderer/features/settings/ProvidersPanel.tsx` | 固定入口、按预设区分草稿键、保存前名称与密钥校验 |
| 连接身份与偏好 | `src/main/app/settings.ts`、`src/main/app/xwxDeckController.ts` | 本地先保存、连接各自模型、缓存身份与过期结果隔离 |
| 目录与协议证据 | `src/main/app/modelCatalog.ts`、`src/main/app/codexProtocolPolicy.ts` | 服务声明优先、明确接口、目录端点及官方能力补全；未知不猜测 |
| 官方账户与模型地址 | `src/main/trace/codexConfigManager.ts`、`src/main/trace/clientConfigWriter.ts`、`src/main/trace/clientConfig.ts` | `openai_base_url` 与 `chatgpt_base_url` 分离，旧账本仍按字段恢复 |
| HTTP / WebSocket 转发 | `src/main/app/xwxDeckController.ts`、`src/main/trace/tapProxy.ts` | `buildCodexSelectionAliases`、各请求入口、发出前模型替换与原始 Trace 保留 |
| Trace 策略与修复 | `src/renderer/features/settings/SettingsPage.tsx`、`src/renderer/features/settings/TraceIndexRepairSection.tsx`、`src/main/gatewayHelper.ts` | 显式存储策略、后台清理调度、停止写入后手动检查与重建 |
| 安全退出 | `src/main/exitRecovery.ts`、`src/main/trace/clientConfigWriter.ts` | 字段级三方恢复；冲突不整文件覆盖，本地依赖未解除不终止 Gateway |

## 为什么切换后会把 GPT 模型发给 DeepSeek

客户端进程可能保留先前连接或模型。只更新磁盘配置和界面选择，不能保证当前会话下一次请求立即换成新模型。此前，Gateway 转发请求时未统一处理跨连接的旧模型名，会把 `gpt-6.1-sol` 交给只接受 DeepSeek 模型的入口。

现在模型别名来自本地已记住的选择，并以当前连接所选模型为目标。目标目录有效的模型不会被改写，未知手填模型也不会被盲目替换。HTTP Responses、Chat Completions、压缩请求和 WebSocket 使用同一条路由规则；WebSocket 在发出请求前替换模型，Trace 保留原请求证据。

此修复作用于经过 XwX Deck Gateway 的请求。已缓存远端直连地址的客户端进程仍可能绕过 Gateway；切换后提示完整退出并重新打开客户端，服务本身是否支持协议和模型还需实际请求验证。

## 回归入口

| 测试 | 覆盖 |
| --- | --- |
| `tools/official-provider-smoke.ts` | 预设注册、官方模型地址、DeepSeek → 方舟 → 官方的真实本地请求；最终 URL、凭据、模型、压缩和有效/未知模型保留 |
| `tools/core-smoke.ts` | WebSocket 别名转发、退出冲突保留配置与 Gateway、Trace 默认策略和索引修复 |
| `tools/provider-selection-regressions.ts` | 两客户端独立选择、A-B-A 模型恢复、仅模型变化的重启提示 |
| `tools/manager-ipc-regressions.ts` | 服务保存、Trace 策略 IPC 与参数校验 |
| `src/main/smoke/packagedSmoke.ts` | 打包后的真实界面、九个客户端/服务入口、自定义表单、分页诊断、配置与 Trace 请求 |
| `tools/run-packaged-background-gateway-smoke.mjs` | 管理器退出窗口后后台 Gateway 的实际请求和重新附着 |

运行完整源码回归：

```bash
npm run compile
npm run test:built
npm run test:upstream
npm run check:public-boundary
npm run check:workflows
npm run docs:build
```

构建后运行 `npm run test:packaged` 和 `npm run test:packaged-gateway`。测试使用临时客户端目录与本地服务；通过这些测试不代表已测试所有真实服务商账户。

界面可用 `npm run preview:web` 预览。预览数据适合检查布局与交互，真实 IPC 和请求以 Electron 打包回归为准。

## 按能力吸收时的边界

移植时可按界面入口、官方模型路由、切换别名、Trace 策略和退出保护分别审查，并带上相应回归。图标、共享注册表、IPC、主进程和 helper 的配套修改需要一起核对，不能只复制渲染组件。

本仓库保持独立应用身份、空初始连接和公开发布渠道；不引入配置同步、Excel、内部默认服务或历史别名。对话诊断继续只读取 SQLite 元数据与首条 `session_meta`。这些改动尚不表示已移植到任何其他仓库。
