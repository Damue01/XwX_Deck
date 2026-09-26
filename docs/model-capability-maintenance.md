# 兼容服务 模型能力维护

本文件描述 XwX Deck 当前模型目录链路和能力基线的维护规则。可执行事实的源码入口是
[`src/main/app/builtInModelCapabilityRegistry.ts`](../src/main/app/builtInModelCapabilityRegistry.ts)、
[`src/main/app/officialModelRegistry.ts`](../src/main/app/officialModelRegistry.ts)；本文用于审查来源和变更流程。

## 1. 当前运行链路

1. 从 兼容服务 `/v1/models`、`/anthropic/v1/models`、`/gemini/v1beta/models` 拉取模型。
2. 按模型 ID 合并重复项，保留各端点声明的协议和客户端入口。
3. 丢弃 兼容服务 返回的逐模型能力字段，只保留模型存在性和实际端点成员关系。
4. 先加载随安装包发布的内置能力注册表，再用厂商官方覆盖、本地最后成功的 models.dev/LiteLLM 快照和本次远程刷新按字段更新。
5. Claude 使用合并后的目录决定模型映射、上下文窗口和允许使用 `[1m]` 的档位。
6. ChatGPT 生成 `.codex/xwx-compatible-catalog.json`；启用 兼容服务 时刷新目录并写入 `model_catalog_json`。
7. ChatGPT 重启后读取新目录；Gateway 可在运行中按模型切换 Responses、Chat Completions 或 Anthropic Messages。
8. Trace 只决定是否记录请求，不决定 Gateway 是否继续转发。
9. 关闭服务或 Trace overlay 时按字段恢复；检测到用户或其他软件并发修改时保留外部值。

## 服务端即时刷新

模型名称、能力和费用属于数据更新，不要求随应用代码重新打包。内网 Windows
主机在 `7375` 提供 SSE 失效通知；客户端建立出站长连接，收到
`models`、`capabilities` 或 `pricing` revision 后立即重新读取原始可信来源：

- 模型名称和端点重新读取已配置 兼容服务 的 HTTPS 模型接口；
- 上下文、最大输出和能力重新读取内置注册表、官方覆盖、models.dev 与 LiteLLM；兼容服务 逐模型能力字段不参与合并；
- 费用重新读取 models.dev，并原子替换最后成功缓存；
- Gateway helper 独立刷新费用，使长期驻留的 Trace Viewer 不依赖管理器重启。

推送事件不携带可执行代码、密钥、价格或上下文数值，只表示缓存失效；因此内网
HTTP 上的伪造事件最多触发一次受限刷新，不能向客户端注入模型数据。连接断开时
客户端每 60 秒安静重试一次，同一次中断只记一条警告；重连携带最后收到的 revision，
服务端发现 revision 不一致时只补发一次三主题失效通知，并保留六小时低频刷新兜底。
错误 JSON 和超过 64 KiB 的管理请求分别返回 `400` 和 `413`，不能终止推送进程。Codex 模型目录会立即重写，但 Codex
Desktop 的模型选择器是否立即重载仍由客户端决定，必要时只需重启 ChatGPT，不需
重装 XwX Deck。

模型存在性由 兼容服务 决定。官方覆盖只补充已发现模型的字段，不会凭官方注册表向 兼容服务 目录凭空新增模型。

## 价格来源与完整性

价格目录与模型存在性同样分层，不能把全局聚合目录直接当作当前 兼容服务 价目表：

1. 价目表只列出当前 兼容服务 可见或 Trace 已实际使用的精确模型 ID。
2. models.dev 只提供精确 ID 的字段值；静态子串规则仅在整个目录不可用时参与运行时匹配，不作为模型名称展示。
3. 缓存读、缓存写字段缺失时保持缺失，不再静默补成普通输入价。只有厂商明确声明“不单列缓存写、按普通输入计费”时，规则才记录 `cacheWritePolicy: input`。
4. Anthropic 缓存写按 5 分钟与 1 小时分别计价；Trace 同时保留 `ephemeral_5m_input_tokens` 和 `ephemeral_1h_input_tokens`。
5. Gemini、Volcengine 等按 token-hour 收取缓存存储费的供应商标记为 `storage`。当前 Trace 没有缓存保存时长，使用到该桶时费用显示 `—`，不能输出一个看似完整但漏掉存储费的数字。
6. 任一实际使用的 token 桶缺少可信价格时，该模型费用显示 `—` 并从合计排除；基础输入/输出价格存在不代表缓存费用完整。
7. 每次价格缓存格式升级必须提高 cache version，避免旧版静默派生字段继续冒充远程原值。
8. 按输入长度分档与按时段（峰/谷）计价的模型，其费率是“单条请求”的属性，不能在会话总量上事后还原。Trace 在捕获时就按 `(tier, offPeak, shortOutput)` 拆分用量桶，聚合跨会话时保留分桶；声明了分档或峰谷规则却没有捕获到分桶的规则不报价，避免静默按最便宜档位计费。
9. Volcengine 对 `doubao-seed-1.6` / `-1.8` 在单条回复不超过 200 token 时按低输出价计费；该“短回复折扣”作为独立维度随用量桶记录，回复长度在捕获时判定。
10. 价格来源按可信度分级并在价目表标注：`官方`（直接读取厂商牌价）、`交叉`（多个独立目录一致）、`单源`（仅一个目录且未交叉核对）。Azure Retail（`Foundry Models`）与 AWS Bedrock 价格表用于交叉核对非中国厂商；OpenRouter 仅按端点读取一线厂商的缓存列作为补缺，不参与输入/输出价投票，也不采用其自身折扣档。OpenRouter 顶层模型列表取最便宜端点，会静默低估（如 `gpt-5.6-sol` 低估 2 倍），因此必须以端点为单位读取并通过标签、锚定与缓存写语义三道门禁过滤。

2026-08-18 对真实 兼容服务 目录的审计为 80 个可见模型，其中 60 个能匹配基础价格、20 个没有可信基础价格。该数字是当日证据，不是固定产品常量；模型刷新后应重新审计。

## 2. 能力来源

| 层级 | 所有权 | 规则 |
|---|---|---|
| 兼容服务 模型存在性/端点 | 当前服务 | 只决定模型是否存在、出现在哪些实际协议端点；忽略逐模型能力字段。 |
| 发布内置能力表 | `builtInModelCapabilityRegistry.ts` | 随安装包提供可离线使用的精确 ID 基线；不会凭空新增 兼容服务 未返回的模型。 |
| 厂商官方能力覆盖 | `officialModelRegistry.ts` | 只记录可引用的模型所有者文档、核验日期和明确字段；未确认字段保持缺失。 |
| 本网关实测 | `probedModelCapabilityRegistry.ts` | 只记录探针**直接观测到**的字段和观测方式。排在聚合目录之上：厂商页描述模型自己的 API，聚合目录描述某个目录的看法，只有探针观测的是当前服务链路的实际行为。仅限可观测字段——推理会在响应里报 reasoning token，上下文窗口和价格不可观测，不得写入此层。 |
| models.dev / LiteLLM | 外部聚合目录 | 使用本地最后成功快照快速启动，完整刷新后按字段更新；冲突别名必须满足现有保守匹配规则。 |
| 保守默认值 | XwX Deck 运行时 | 未核验上下文在 Codex 目录中使用 256K；未知输出使用 8192 token；未知工具能力静默按兼容模式尝试。所有默认字段标记为 `fallback`，不冒充官方能力。 |

能力缺口不会禁用用户选择，模型选择器也不展示逐行能力诊断。已知非对话用途的 embedding、图片生成和 OCR 模型从对话模型目录过滤；用途不明确但可通过对话端点调用的模型继续允许选择和实际尝试。

## 端点与协议边界

路由不按模型名称或厂商推断。服务明确声明 Responses 时优先直通；否则使用声明的 Chat Completions 或 Anthropic Messages，缺失声明时使用连接的协议设置。模型出现在标准 OpenAI `/models` 中只证明目录成员关系，不等于支持两种协议。Anthropic 专用目录可作为 Messages 端点证据。

历史探针只能描述当时的连接，不应用为其他服务的全局协议规则。协议转换必须保留工具、推理强度和历史上下文，并用真实 Gateway 请求验证。

## 聚合目录可靠性

- 当前 兼容服务 75 个模型中，66 个可在 models.dev 或 LiteLLM 找到精确/标点等价 ID。
- 兼容服务 模型名称目录与能力补全解耦：已有能力快照时立即使用内置表和最后成功缓存；全新电脑没有能力快照时允许等待最长 12 秒的有界能力请求，避免先写出错误 fallback 再产生孤立后台更新。
- 最近一次完整 兼容服务 目录写入 `compatible-model-catalog-cache.json`。冷启动先显示同一地址和密钥对应的缓存，再刷新三个端点；密钥只参与 SHA-256 连接标识，不以明文写入缓存。
- 三个 兼容服务 端点独立更新。某个端点临时失败时只沿用该端点的上次目录，其他成功端点仍采用最新结果，避免一次网络波动让整类模型消失。
- 远程能力目录请求超时为 12 秒；成功结果会写入 `model-capabilities-cache.json` 的精简缓存。网络、DNS 或 TLS 异常时只使用最后一次通过校验的缓存，绝不关闭 TLS 校验。
- 同一精确模型在不同渠道的上下文或输出限制不一致时：原厂条目优先；没有原厂条目时使用最小正整数，避免把较宽的转售商限制套到 兼容服务。
- 不做无边界的家族模糊匹配。日期后缀、内部别名只有得到明确来源或真实协议验证后才能加入显式覆盖。

### 两个控制字段的分工

Chat Completions 路线上有两个互不替代的字段，混为一谈就会得出"这个模型只有三个假档位"的错误结论：

- **toggle（开关）**：只表达思考开或关，没有程度。字段为 `thinking: {"type": "enabled"|"disabled"|"auto"}` 或 `enable_thinking: true|false`。MiniMax 例外，它只接受 `adaptive|disabled`，发 `enabled` 会返回 400。
- **effort（力度档位）**：表达思考多深。字段为 `reasoning_effort`，取值来自 `none|minimal|low|medium|high|xhigh|max` 的子集，每个模型的子集不同。

正确的发送方式是两者各管一件事：**关思考时发 toggle 的关闭值；开思考时发 toggle 的开启值加上 effort 的具体档位。** 只发 toggle 会让所有档位塌成同一个请求，这正是假档位的成因。

### 判据：三个问题必须分开回答

| | 问题 | 判定方式 | 谁负责 |
|---|---|---|---|
| A | 选不同档位时**我们发出的请求体**是否不同 | 静态读代码即可，零成本 | 本网关 |
| B | 上游是否真的按档位改变思考量 | 需要每档多次采样比中位数 | 厂商 |
| C | 上游是否**拒绝**某个档位 | 探针看 HTTP 状态，可靠且便宜 | 本网关 |

**发布规则：只发布 A 成立且 C 不报错的档位，不试图证明 B。** 用户能感知的"选了没变化"是 A；"厂商内部分几层"是 B，不由本产品承担。

单次采样的 reasoning token 数**不能**作为证据：实测同一模型同一档位的波动可达一个数量级（`grok-4.5` 在 low/medium/high/max 上分别为 1620/469/2789/195）。可信信号只有两个：HTTP 400 拒绝，以及 reasoning token 归零代表的"确实关闭"。

### 实探工具

[`tools/probe-reasoning-contract.mjs`](../tools/probe-reasoning-contract.mjs) 对当前配置的网关逐模型探测可接受的控制字段。它默认 dry-run、不进入 `npm test`、不打印或记录 bearer token。`--all` 会从 `/v1/models` 取全部 chat 家族模型，`--send` 才真正发请求。改动任何已发布档位表之前先跑它，并把日期写进本节。

## 推理档位收敛（effort / thinking）

聚合目录只回答"这个模型能不能推理"，不回答"网关接受哪个控制参数"。直接采用聚合档位会把只有开关的模型填成 `low/medium/high`，用户在选择器里能调、发出去的请求却完全相同。因此在目录写入前加一层收敛，源码入口是
[`codexModelCatalogManager.ts`](../src/main/trace/codexModelCatalogManager.ts) 的 `verifiedCatalogReasoning`
与 [`compatibleServiceReasoningProfiles.ts`](../src/main/trace/compatibleServiceReasoningProfiles.ts)。

### Codex 侧契约（实测 codex `0.148.0-alpha.9`，2026-08-19）

- `supported_reasoning_levels` 是模型选择器的唯一来源。`ReasoningEffort` 带 `Custom(String)` 分支，任何拼写都会被原样转发，**Codex 不校验档位在上游是否可行**；全代码库唯一的成员检查在 `spawn_agent` 子智能体工具里。可行性只能由本网关负责。
- 未配置 effort 时按 `default_reasoning_level` 发送；只有档位列表为空且没有默认值时才省略 `effort` 键。空列表加无默认值是 Codex 表达"非推理模型"的唯一方式。
- **会话中途切换模型**且当前档位不在新模型列表里时，Codex 取下标 `(len - 1) / 2`，并且**不读** `default_reasoning_level`。两元素列表即下标 0，所以双档列表必须把安全档位排在首位（当前为 `['high', 'none']`）。
- `ultra` 会在发送前被改写成 `max`，公布它等于公布一个与 `max` 完全同义的重复档，因此不进入白名单。
- 目录字段类型或封闭枚举（`shell_type`、`visibility`、`input_modalities`、`truncation_policy.mode`）出错会让 Codex **启动即失败且无任何回退**，因此写入前必须保证必填字段齐全。`max_output_tokens`、模型级 `supports_websockets` 和 `supports_reasoning_summaries` 都不在 schema 内；推理摘要的真实字段名是 `supports_reasoning_summary_parameter`，其默认值为 `true`，省略等于开启。

### 收敛规则

1. **toggle + effort 都可用的模型**：发布探针未被拒绝的完整阶梯，关思考走 toggle、力度走 effort。档位值原样透传——本地折叠（旧实现把 DeepSeek 的 medium/high/xhigh 都折成 `high`）会在这一层内部重新制造重复档位。
2. **只有 effort、拒绝一切 toggle 的模型**（`glm-5.3`、Grok 全系）：只发 effort，且不发布 `none`——`glm-5.3` 与 `grok-4.6` 对它直接返回 400，`grok-4.5` 收下却继续思考。
3. **只有 toggle、effort 是兼容摆设的模型**（`MiniMax-M3`）：只发布 `['high', 'none']` 两档，且 `high` 必须在首位。
4. **固定思考且无任何可用控制的模型**（`MiniMax-M2.x`、`grok-4.20-*`）：档位列表为空，不展示选择器。
5. **探针中毫无校验、也无行为证据的私有别名**（`qwen3-coder-plus`、`qwen-plus-character`、`gui-plus`）：不猜测控制字段。

字段选择上统一用 `thinking` 而非 `enable_thinking`：后者在 `kimi-k3` 与 `MiniMax-M3` 上返回 200 却继续思考，属于最坏的失败形态——用户以为关掉了，实际照付思考费用。

### 当前发布的档位（实探 2026-08-19）

| 家族 | 发布档位 | 默认 | 依据 |
|---|---|---|---|
| `qwen3.x` | none, low, medium, high, xhigh | high | `max` 被拒 |
| `qwen3.8-max` | ＋ max | high | 唯一接受 `max` 的 Qwen |
| `glm-5` / `5.1` | none, low, medium, high, xhigh | high | `max` 被拒 |
| `glm-5.2` / `glm-5v-*` | ＋ max | high | — |
| `glm-5.3` | low, high, max | high | 除此之外全部 400，且关不掉 |
| `deepseek-v4-*` | none, low, medium, high, xhigh, max | high | `effort:none` 被拒，off 走 toggle |
| `kimi-k2.5/2.6/2.7-code` | none, low, medium, high, xhigh | high | `max` 被拒 |
| `kimi-k3` | ＋ max | max | Moonshot 文档默认 `max` |
| `doubao-seed-1-6*` | none, low, medium, high | high | `xhigh`/`max` 被拒 |
| `doubao-seed`（其余） | none, low, medium, high, xhigh, max | high | — |
| `MiniMax-M3` | high, none | high | effort 为兼容摆设 |
| `grok-4.6` | low, medium, high, xhigh | high | `none`/`max` 被拒 |
| `grok-4.3` / `4.5` | low, medium, high, xhigh | high | 无 toggle 可用 |

端到端校验：`node tools/run-bridge-level-check.mjs` 把桥接**实际生成**的请求体逐条发往网关，2026-08-19 为 42 个模型的 202 个档位组合全部 200。改动任何档位后重跑它，而不是只看单元测试。

### 已核验来源

| 厂商 | 结论 | 来源与日期 |
|---|---|---|
| xAI Grok | `low\|medium\|high\|xhigh`，默认 `high`；**推理不可关闭**，`none` 非法。仅 4.6 honour `xhigh`，4.5 上等于 `high`。4.20 的该参数控制协作 agent 数量，不是思考深度 | [docs.x.ai/docs/guides/reasoning](https://docs.x.ai/docs/guides/reasoning)，2026-08-19 |
| Alibaba Qwen | `enable_thinking` 布尔 + `thinking_budget` 数值；`reasoning_effort` 仅 `qwen3.8-max` 支持，枚举为 `low\|medium\|xhigh`（默认 `xhigh`），`high` 会被映射成 `xhigh`，`none` 映射为 `enable_thinking=false`；`reasoning_effort` 与 `thinking_budget` 同时设置报错 | [百炼深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)、[OpenAI 兼容 Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)，2026-08-19 |
| DeepSeek V4 | `thinking` 开关 + `reasoning_effort`；`deepseek-v4-pro-0813` 为 `low\|high\|max`，默认 `high`，`medium` 与 `xhigh` 均映射为 `high` | 同上（阿里云直供条目），2026-08-19 |

阿里云与 xAI 文档只能证明**厂商原生契约**，不能证明 兼容服务 转发时接受什么，实探已多次证明两者不一致：xAI 文档写明"推理不可关闭"，但 `grok-4.3` 在本网关上 `effort:none` 确实把 reasoning token 打到 0；Moonshot 文档写明 `kimi-k3` 始终思考，但 `thinking:{type:"disabled"}` 在本网关上确实关闭了它。因此**厂商文档用于解释语义，档位表以实探为准**。

### 实探的判读边界

**200 不等于"支持"。** 全量矩阵显示本网关对很多模型根本不校验参数：非推理的 `grok-4.20-0309-non-reasoning` 收下了全部五种 toggle；`deepseek-v4-pro` 拒绝 `effort:none`，而它的快照 `deepseek-v4-pro-0813` 却全收。因此：

- **400 是可靠证据**，它证明该字段真的被解析和校验，并划出真实取值范围；
- **200 什么都不证明**，可能被静默忽略；
- **reasoning token 归零是行为证据**，可用于确认"确实关闭"。

无校验的模型（`doubao-seed-2.x`、`grok-4.3/4.5`、`gui-plus`、各 `*-character`、`kimi-k3-external`、DeepSeek 快照）无法据此判断档位是否被采纳。对它们发布阶梯的依据是判据 A——我们确实为每档发出了不同的请求；是否被采纳属于判据 B，不由本产品承担。

## 3. 当前官方覆盖

核验日期逐项记录在代码中；本轮跟进了 2026-09-24 的 DeepSeek Responses 能力更新。数字单位为 token；`—` 表示官方页面未建立该字段，不能猜测。

| 模型 | 上下文 | 最大输出 | 官方协议 | 工具 | Claude `[1m]` | Codex 推荐路径 |
|---|---:|---:|---|---|---|---|
| `deepseek-v4-flash-260425` | — | — | Responses | 是 | 不添加 | 原生 Responses |
| `doubao-seed-2-1-turbo-260628` | — | — | Chat Completions | — | 不添加 | Chat Completions bridge |
| `deepseek-v4-pro` | 1,000,000 | 393,216 (384K) | Responses、Chat Completions、Anthropic Messages | 是 | Opus、Sonnet | 服务声明后优先 Responses |
| `deepseek-v4-flash` | 1,000,000 | 393,216 (384K) | Responses、Chat Completions、Anthropic Messages | 是 | 不添加 | 服务声明后优先 Responses |
| `glm-5.2` | 1,000,000 | 131,072 | Chat Completions、Anthropic Messages | 是 | Opus、Sonnet | Chat Completions bridge |
| `kimi-k3` | 1,048,576 | — | Chat Completions、Anthropic Messages | 是 | Fable、Opus、Sonnet、Haiku | Chat Completions bridge |
| `kimi-k2.7-code` | 262,144 | — | Chat Completions | 是 | 不添加 | Chat Completions bridge |
| `kimi-k2.6` | 262,144 | — | Chat Completions | 是 | 不添加 | Chat Completions bridge |
| `kimi-k2.5` | 262,144 | — | Chat Completions | 是 | 不添加 | Chat Completions bridge |

### DeepSeek

- [Responses API](https://api-docs.deepseek.com/guides/responses_api/)

- [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [Claude Code integration](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)

### GLM

- [GLM-5.2 model guide](https://docs.z.ai/guides/llm/glm-5.2)
- [Z.AI Claude Code model switching](https://docs.z.ai/devpack/latest-model#switching-models-in-claude-code)

### Kimi

- [Kimi model catalog](https://platform.kimi.com/docs/models)
- [Kimi Claude Code integration](https://platform.kimi.com/docs/guide/claude-code-kimi)

### 火山方舟

- [火山方舟 API 文档](https://www.volcengine.com/docs/82379)
- `deepseek-v4-flash-260425` 的 Responses 路径和 `web_search` 请求结构按
  2026-08-18 提供的方舟调用样例验证。
- `doubao-seed-2-1-turbo-260628` 的 Chat Completions 多模态结构按
  2026-08-18 提供的方舟调用样例验证。

## 4. 新增或更新覆盖

1. 先确认模型仍由 兼容服务 某个端点返回，不把注册表当模型存在性目录。
2. 只接受模型厂商或产品所有者页面；聚合站只能进入 models.dev/LiteLLM 层。
3. 在 `OFFICIAL_MODEL_REGISTRY` 增加精确模型 ID、来源 URL、核验日期、明确能力、协议、Claude `[1m]` 档位和 Codex 推荐路径。
4. 官方页面未写明最大输出、视觉或工具能力时省略字段，不用同系列模型外推。
5. 兼容服务 只参与模型存在性和端点筛选；能力更新写入内置注册表、官方覆盖或外部能力层，不能把 兼容服务 逐模型能力声明重新引入优先级。
6. 更新本表，并为能力优先级、`[1m]` 档位和 Codex 路由增加 smoke 断言。
7. 运行 `npm run check-types`、`npm test`、`npm run compile` 和相关真实客户端验收。

厂商更新页面后必须提高 `verifiedAt`，并重新核对所有记录字段；仅修改 URL 文案不算重新核验。
