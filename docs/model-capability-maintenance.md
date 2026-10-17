# 模型能力与价格维护

本文说明当前 Rust 后端的数据来源和维护方法。
模型目录、能力补全和价格计算分别维护。
目录中存在模型，不代表真实请求已经通过。

## 代码入口

| 能力 | 当前入口 |
| --- | --- |
| 服务目录、能力合并与协议选择 | [catalog.rs](https://github.com/Damue01/XwX_Deck/blob/main/src-native/src/catalog.rs) |
| 显式能力字段与模型用途 | [catalog_metadata.rs](https://github.com/Damue01/XwX_Deck/blob/main/src-native/src/catalog_metadata.rs) |
| models.dev 解析与保守匹配 | [model_metadata.rs](https://github.com/Damue01/XwX_Deck/blob/main/src-native/src/model_metadata.rs) |
| 可维护的官方协议表 | [model-protocols.json](https://github.com/Damue01/XwX_Deck/blob/main/assets/model-protocols.json) |
| 协议表校验与合并 | [official-models.mjs](https://github.com/Damue01/XwX_Deck/blob/main/tools/build/official-models.mjs) |
| 公共目录刷新与最后成功缓存 | [metadata.rs](https://github.com/Damue01/XwX_Deck/blob/main/src-native/src/metadata.rs) |
| 服务声明的价格 | [provider_pricing.rs](https://github.com/Damue01/XwX_Deck/blob/main/src-native/src/provider_pricing.rs) |
| 请求费用与历史快照 | [trace_pricing.rs](https://github.com/Damue01/XwX_Deck/blob/main/src-native/src/trace_pricing.rs) |
| 用量归一化 | [trace_usage.rs](https://github.com/Damue01/XwX_Deck/blob/main/src-native/src/trace_usage.rs) |
| 索引、聚合与存储策略 | [storage.rs](https://github.com/Damue01/XwX_Deck/blob/main/src-native/src/storage.rs) |
| 前端共享目录类型 | [model-catalog.ts](https://github.com/Damue01/XwX_Deck/blob/main/src/shared/model-catalog.ts) |
| 离线资源生成 | [native-assets.ts](https://github.com/Damue01/XwX_Deck/blob/main/tools/build/native-assets.ts) |

## 模型目录

模型存在性来自当前连接的目录。
普通 API 连接使用其规范化地址下的 `models` 接口。
认证方式沿用该连接的明确设置。
不会向服务目录补入整个公共模型列表。

目录缓存绑定连接身份和协议。
先显示同一连接的缓存，再刷新远端目录。
刷新失败保留最后成功的数据和用户选择。
迟到结果不能覆盖之后选择的连接或模型。

保存服务和模型属于本地配置操作。
目录离线不能阻止保存明确的模型 ID。
用户手动选择的模型可加入对应 Codex 目录。
这种补入不代表服务确认支持该模型。

Codex 目录文件为 `xwx-deck-model-catalog.json`。
程序校验并写入客户端需要的字段。
客户端是否立即重新读取，由客户端自身决定。
不能只凭目录写入成功确认正在运行的客户端已生效。

## 能力来源

能力逐字段合并，并保留来源。
当前顺序为服务显式字段、models.dev、保守默认值。
服务明确声明的 `false` 也是有效值。
不能用聚合目录的 `true` 覆盖该声明。

[models.dev](https://models.dev/) 是公共能力和参考价格的主来源。
解析保留精确模型身份和明确别名。
跨渠道数据采用保守匹配。
不按模型家族名称无限扩大匹配范围。

启动时可以使用随包提供的 models.dev 资源。
有效的最后成功缓存也可继续使用。
后台刷新只替换通过校验的数据。
XwX Deck 默认没有内部通知地址。

缺失字段不会冒充厂商能力。
当前上下文兜底为 262,144 个 Token。
最大输出兜底为 8,192 个 Token。
来源均标为 `fallback`。
这些值用于兼容，不证明上游实际限制。

已确认的下线状态和非对话用途分别处理。
普通鉴权失败、临时网络错误和额度不足不表示模型下线。
未知能力也不能撤销用户的明确选择。

## 协议选择

服务声明是路由的依据。
模型出现在普通目录中，不等于支持全部协议。
不能仅根据厂商名称或模型名称选择协议。

当前路由优先保留明确支持的原生 Messages 请求。
其他请求优先使用服务声明的 Responses。
其次为 Chat Completions，再次为 Messages。
没有有效声明时，使用连接配置的协议。

协议没有可依赖的第三个聚合来源。
models.dev 和 OpenRouter 的公开模型资料都不声明 Responses、Chat Completions 或 Messages 的线路协议。
缺少服务声明和已核验官方记录时，使用连接配置的协议。
不从相似型号或聚合目录推测协议。
实际转发仍以当前连接和请求入口为准。

当前协议表位于 `assets/model-protocols.json`。
每行只记录 `modelId`、`vendor`、`protocols` 和官方 `sourceIds`。
构建时由 `tools/build/official-models.mjs` 合并到 `official-models.json`，已有静态能力字段优先，不会被协议表覆盖。
表中的来源域名受白名单限制，协议值只允许 Responses、Chat Completions 和 Messages。
未知协议、重复 canonical 型号或非官方来源会使构建失败，而不是静默写入。

推理开关与推理力度是不同能力。
目录只发布有明确来源的控制选项。
转换过程应保留可表达的工具结果和推理选项。
上游拒绝或内容无法表示时，返回明确错误。
不能通过制造结束事件或重发已输出内容完成请求。

## 价格与用量

参考价格以 models.dev 为主来源。
服务目录也可声明连接自身的价格。
没有可用参考价格时，才使用有效的服务价格快照。
不能把不同来源的费率拼成一张价格卡。

每条请求分别冻结价格和用量证据。
记录包含 `referencePrice`、`providerPrice` 和 `costSnapshot`。
后续目录刷新不能用新价格重算已有快照。
已记录的来源、费率和时段仍可核对。

缓存读取、缓存写入和输出分别计价。
输入总量与缓存量不能重复累计。
可选字段缺失与必要用量缺失分别判断。
只有唯一可推导的值，才能按既定规则补全。

缓存写入费不能随意补成普通输入价。
已声明的缓存写入策略需要保留来源。
使用缓存存储计费时，还需对应存储时长。
缺少必要信息时，记录具体未计价原因。

分档、时段和短输出规则属于单条请求。
不能在会话累计量上重新推断请求档位。
计算所需信息不完整时，金额保持未知。
失败请求如有可信用量，仍可能产生已知费用。
HTTP 状态本身不能证明是否收费。

仪表盘正常显示已知金额。
一条请求缺少用量，不给整个会话金额加星号。
列表、汇总和悬停不显示未计价数量或保底说明。
具体缺项来源保留在记录中。
总览不在 Token 下增加一行警告。
本地估算不能替代服务商账单。

历史修正只处理已确认的计费语义。
修正沿用原快照，不套用今天的价目表。
原始 JSONL 保留，读取时应用受限修正规则。

## 维护与验证

修改数据规则时，先核对实际解析入口。
保留精确字段、来源和失败边界。
更新共享资源时，执行 `npm run update:pricing`。
该命令刷新开发资源，不安装或发布应用。

| 回归入口 | 核心检查 |
| --- | --- |
| `tools/native/catalog-contract-test.mjs` | 服务显式字段与来源优先级 |
| `tools/native/catalog-contract-edges-test.mjs` | 缺失字段、冲突与目录边界 |
| `tools/native/model-protocols-test.mjs` | 协议表来源、合并优先级与重复型号 |
| `tools/native/models-dev-unification-test.mjs` | 能力主来源与协议边界 |
| `tools/native/price-catalog-test.mjs` | 价格单位、来源与匹配 |
| `tools/native/trace-billing-test.mjs` | 每请求快照与计费完整性 |
| `tools/native/trace-cache-usage-test.mjs` | 缓存用量与重复累计保护 |
| `tools/native/trace-usage-only-test.mjs` | 仅用量模式与历史统计 |
| `tools/native/dashboard-layout-test.mjs` | 单行布局和已知金额显示 |

程序回归使用隔离配置和本地合成上游。
真实授权、实际客户端和真实账单分别验收。
历史目录数量或旧模型结果不作为当前支持范围。

## Codex 运行窗口

模型容量与 Codex 默认窗口分别维护。
服务明确声明的有效容量优先。
普通能力缺失时继续读取 models.dev。
客户端的精确型号缓存提供当前默认窗口。
已核验的服务容量限制运行窗口。

默认选择不写入固定窗口覆盖。
客户端资料更新后，默认值随之更新。
已有明确窗口和可选 1M 设置继续保留。
选择默认窗口时才移除旧覆盖。
不再把 GPT 默认窗口固定为 256K。

生成目录保留原生 `model_messages` 模板。
它与 `base_instructions` 都是有效指令来源。
格式、续接和测试边界见 [Codex 专项验收](maintenance/codex-provider-continuation-acceptance.md)。

字段更新与客户端消费的检查见 [链路审计](model-metadata-consumption-audit.md)。
