# 服务配置与请求路由

本文说明 XwX Deck 的配置、目录和 Gateway 链路。
Gateway 是本机的模型请求转发入口。
当前后端使用 Rust，界面使用 React。

## 用户选择

新安装没有 API 连接。
选中服务预设只预填表单，不创建连接。
保存后，用户再为客户端选择服务和模型。
导入或登录也不自动替换当前选择。

添加配置使用一个窗口。
四个标签为 API 服务、订阅账号、我的配置和客户端管理。
不同服务保留各自未保存的草稿。
普通配置只编辑名称、URL 和 Key。
已有明确协议与模型设置继续保留。

显示名称支持中文、空格和其他 Unicode 字符。
最多 80 个字符，不能为空白或包含控制字符。
显示名称与稳定 ID 分开维护。
同名连接各自保存，改名不改变已有身份。

服务、模型与账号以用户最后一次选择为准。
目录离线或迟到结果不能撤销本地选择。
保存成功不等于真实请求已经成功。
错误信息应说明已保存内容和可继续的操作。

## 代码入口

| 能力 | 当前入口 | 核心边界 |
| --- | --- | --- |
| 服务预设和下载 | `src/shared/officialProviders.ts`、`src/shared/clientDownloads.ts` | 预填不保存，客户端下载不冒充自动配置 |
| 配置卡片与草稿 | `src/renderer/features/settings/ProvidersPanel.tsx` | 表单校验、分别保留输入和服务身份 |
| 配置持久化 | `src-native/src/settings.rs`、`src-native/src/core.rs` | 保存最新选择，保留外部修改 |
| 目录与协议 | `src-native/src/catalog.rs`、`src-native/src/catalog_metadata.rs` | 服务声明优先，未知不按名称猜测 |
| 官方模型请求 | `src-native/src/official_chatgpt.rs`、`src-native/src/official_accounts.rs` | 凭据、账号和模型地址分别处理 |
| 客户端接管 | `src-native/src/client_wiring.rs`、`src-native/src/clients.rs` | 备份负责字段，保持其他配置 |
| HTTP 与 WebSocket | `src-native/src/core.rs`、`src-native/src/websocket.rs` | 保留原请求与实际转发证据 |
| 跨服务续接 | `src-native/src/continuation.rs`、`src-native/src/service_switching.rs` | 保留上下文，不重发已有输出 |
| Trace 存储与修复 | `src-native/src/storage.rs`、`src/renderer/features/settings/TraceIndexRepairSection.tsx` | 保留在途记录，手动检查和修复 |
| 窗口和安全退出 | `src-native/src/main.rs`、`src-native/src/request_activity.rs` | 外部冲突和活动请求分别处理 |

能力来源和费用规则见 [模型能力维护](model-capability-maintenance.md)。
续接边界见 [上下文可移植性](codex-context-compaction-portability.md)。

## API 与套餐配置

API 服务使用用户保存的地址、协议和密钥。
普通按量服务与 Coding Plan 使用独立预设。
套餐身份不会因修改地址而自动丢失。
Key 由用户填写，保存不会自动发送模型测试请求。

获取密钥时，打开对应服务的官方管理页。
套餐权限、额度和实际可用模型以服务商为准。
目录访问成功不能替代新任务的真实调用。

每个连接分别保留客户端模型和上下文设置。
已有的目录外型号继续保留，模型菜单不提供手动输入入口。
需要协议转换时，通过本机 Gateway 处理。
模型名称或厂商名称不能替代明确协议证据。

## 订阅账号

订阅账号用于官方授权，不是 API Key 表单。
当前提供 ChatGPT、Grok、Copilot、Claude 和 Cursor 入口。
各平台使用对应授权与请求适配。
具体账号是否可用，需要分别验证。

新增账号不替换用户已有服务或模型。
同类账号按用户设置的策略轮换。
保留当前会话的账号关联。
未知额度不伪装为零，也不推断套餐权限。

只有确定的鉴权、额度或型号拒绝才允许安全重试。
重试必须发生在客户端尚未收到输出之前。
流中断、工具已输出和不确定失败不得重放。

跨服务切换默认关闭。
用户需明确启用，并保存服务顺序和各服务的型号。
全部同服务账号确定耗尽后，才按既定策略跨服务。
该能力不提供文件或配置同步。

凭据由原生凭据模块保护。
不得写入网页、普通连接表单或客户端配置。
来源客户端登录按既有授权方式续期。
不同机器、账号和平台的真实验证结果分别记录。

## 已运行的客户端

客户端可能缓存连接或模型。
修改磁盘配置不能证明旧进程已重新读取。
Gateway 只处理实际经过本机端口的请求。

已确认属于其他连接的旧模型选择，可以按规则转换。
当前目标目录中的有效型号与原有目录外型号应保留。
Trace 同时记录原客户端模型与实际转发模型。

开启 Trace 后，先新建任务验证请求入口。
切换服务后，再续接同一个测试会话。
核对上下文、实际服务和 Trace 归属。
如果客户端仍缓存旧直连地址，提示用户重新打开客户端。
产品不为普通服务切换自动关闭客户端。

## 停止、恢复与更新

停止 Trace 时，恢复本产品负责的客户端字段。
外部修改采用字段级合并，不整文件覆盖。
仍有本地依赖或配置冲突时，保留恢复证据并提示。
不能仅凭开关关闭声称已经恢复直连。

Trace 默认上限为 1 GB，并开启自动清理。
已有容量和清理选择继续保留。
手动删除与索引修复仅由用户发起。

macOS 版本下载并校验 DMG。
最终替换由用户手动完成。
源码同步和本地回归不触发安装、更新发布或制品上传。

## 回归与实际验收

| 回归入口 | 核心检查 |
| --- | --- |
| `tools/native/provider-identity-test.mjs` | 显示名称、稳定 ID 和同名连接 |
| `tools/native/provider-dialog-renderer-test.mjs` | 真实配置卡片、草稿和保存 |
| `tools/native/catalog-contract-test.mjs` | 显式服务字段与目录补全 |
| `tools/native/client-config-merge-test.mjs` | 外部配置和负责字段的合并 |
| `tools/native/official-chatgpt-test.mjs` | 官方模型地址、账号与隔离路由 |
| `tools/native/protocol-test.mjs` | 转换、工具结果和流完成边界 |
| `tools/native/portability-test.mjs` | 跨服务续接与不透明状态 |
| `tools/native/service-switching-test.mjs` | 顺序、型号和安全切换 |
| `tools/native/gateway-clients-test.mjs` | 实际 Pi 或 OpenCode 与本地合成上游 |
| `tools/native/native-test.mjs` | 原生 WebView 与实际后端交互 |

完整工程门禁为 `npm run check:quality`。
仓库边界使用 `npm run check:public-boundary`。
界面实测使用隔离原生候选与 `npm run test:native:webview`。
官网预览使用 `npm run build:site` 和 `npm run test:site`。

程序化回归、真实 CLI、真实上游和实际应用操作分别留证。
本地合成上游不能证明真实授权或服务商账单。
XwX Deck 不提供工具页、配置同步、对话诊断或 Excel 转换。
应用身份、数据路径、端口和公开渠道保持独立。
