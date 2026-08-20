# 服务商兼容说明

XwX Deck 的“服务商”指客户端请求最终转发到的模型 API，不限定为 兼容服务。

## 用户只需要填写三项

设置页只显示：

1. 名称；
2. URL；
3. Key。

内部使用哪种模型目录、路径规则和协议适配不会作为用户参数暴露。

服务商名称是唯一显示名称。修改并保存后，设置页、Claude 模型页和 ChatGPT 模型页会同步使用新名称。

## 自动检索流程

保存 URL 和 Key 后，XwX Deck 会自动：

1. 规范化 Base URL，并识别 `/v1`、`/api/v3` 等版本根；
2. 尝试当前 Base URL 下的 `/models`；
3. 尝试标准 OpenAI 模型目录；
4. 尝试 Anthropic Messages 模型目录；
5. 尝试 Gemini 模型目录；
6. 合并重复模型，并保留每个模型公开的协议和能力元数据；
7. 用缓存快速显示最近一次成功获取的模型目录；
8. 后台刷新后替换为最新结果。

某个目录返回 404 不会导致其他目录一起失败。只要至少一个目录成功，就会显示可用模型。

## 自动协议适配

模型目录明确返回协议时，以服务端元数据为准：

| 模型能力 | 发送方式 |
|---|---|
| OpenAI Responses | 原生 Responses |
| Chat Completions | Responses → Chat Completions 本地转换 |
| Anthropic Messages | Responses → Anthropic Messages 本地转换 |

当模型目录只返回普通 OpenAI 模型列表，没有逐模型协议信息时，XwX Deck 才使用保守的模型族识别：

- GPT 系列优先 Responses；
- Claude 系列优先 Anthropic Messages；
- 其他模型优先 Chat Completions。

用户不需要为每个模型填写协议。

## 市面上的主要协议形态

参考 `cc-switch` 当前的供应商和路由实现后，可以把大量品牌归并成以下后台能力维度，而不是维护一张必须由用户选择的中转站名单：

相关参考遵循其 MIT License，归属信息见仓库根目录
`THIRD_PARTY_NOTICES.md`。

### 请求协议

| 协议族 | 常见用途 | XwX Deck 当前状态 |
|---|---|---|
| OpenAI Responses | Codex、GPT、新式 Agent 请求 | 已支持 |
| OpenAI Chat Completions | 大量国内模型和聚合站 | 已支持本地转换 |
| Anthropic Messages | Claude 与 Claude 兼容站 | 已支持本地转换 |
| Gemini Native | Google `generateContent` | 已识别，原生转换仍待补充 |

### 认证方式

| 认证族 | 常见请求头 | XwX Deck 当前状态 |
|---|---|---|
| Bearer Token | `Authorization: Bearer ...` | 已支持，作为默认 |
| Anthropic API Key | `x-api-key` + `anthropic-version` | 后台 Adapter 待补充 |
| Google API Key | `x-goog-api-key` | 后台 Adapter 待补充 |
| Azure API Key | `api-key` | 路径和查询参数 Adapter 待补充 |
| OAuth | 动态 Bearer Token | 仅官方 ChatGPT 流程已支持 |
| AWS SigV4 | 签名请求 | 待补充 |
| 自定义 Headers | 供应商自定义头 | 待补充受限白名单 |

### URL 形态

后台模型目录推导现在支持：

- 普通 Base URL：自动尝试 `/v1/models` 和 `/models`；
- 已带版本根：如 `/v1`、`/api/v3`、`/api/coding/paas/v4`，优先追加 `/models`；
- 非 `v1` 版本根：同时保留 `/v1/models` 作为兼容兜底；
- 完整请求 URL：如 `/v1/chat/completions`、`/responses`、`/messages`，自动回推模型目录；
- Anthropic/Coding 兼容挂载：识别 `/anthropic`、`/api/anthropic`、`/claudecode`、`/api/coding` 等常见后缀，并从根路径继续探测。

这些规则位于后台 `providerDiscovery.ts`，不会增加前台字段。

### 仍需后台处理的差异

不同服务商还可能在以下方面存在差异：

- reasoning 参数名和允许档位；
- `thinking`、`enable_thinking` 与 `reasoning_effort`；
- reasoning 输出位于 `reasoning_content`、thinking block 或加密签名；
- tool call / tool result 结构；
- prompt cache 字段；
- SSE 事件名称与 usage 位置；
- 完整 Endpoint URL 而不是 Base URL；
- 模型目录需要额外 Header 或独立 URL。

后续实现会继续落在 Provider Adapter 和模型能力元数据层，不重新增加用户配置项。

## OpenAI 兼容中转站

满足以下形式的服务通常可以自动接入：

- 使用 `Authorization: Bearer <key>`；
- 暴露 `/models`；
- 暴露 `/responses` 或 `/chat/completions`；
- Base URL 使用 `/v1`、`/api/v3` 等版本根。

工具调用、reasoning、usage 和流式事件是否完整，仍取决于上游兼容程度。

## 兼容服务 多协议

当 URL 同时提供 OpenAI、Anthropic 和 Gemini 模型目录时，自动探测会合并这些模型，不需要用户选择“兼容服务 模式”。

检测到 Anthropic Messages 模型后，Claude 代理入口会自动可用；只有 OpenAI 模型目录时，Claude 入口保持禁用并说明原因。

## 火山方舟

火山方舟 OpenAI 兼容入口通常使用：

```text
https://ark.cn-beijing.volces.com/api/v3
```

XwX Deck 会自动识别 `/api/v3` 是版本根，并把：

```text
/v1/responses
```

转发为：

```text
/api/v3/responses
```

不会错误拼成 `/api/v3/v1/responses`。

如果当前方舟凭据或入口不提供模型目录，XwX Deck 无法凭空知道用户账号下的 Endpoint ID。这种情况下只在模型页保留一个手动输入模型或 Endpoint ID 的降级入口，其他服务商仍继续自动检索。

方舟 OpenAI 兼容入口当前用于 ChatGPT/Codex，不直接用于 Claude。

### 已验证的两种方舟请求

`deepseek-v4-flash-260425` 的 Responses 示例按以下方式处理：

- `/v1/responses` 自动映射到 `/api/v3/responses`；
- Bearer Token 由本地 Gateway 注入；
- `stream: true` 保留；
- `web_search` 和 `max_keyword` 原样保留；
- `input_text` 数组原样保留；
- Responses SSE 的 `response.output_text.delta`、`response.completed` 等事件继续按 Responses 解析。

`doubao-seed-2-1-turbo-260628` 的 Chat Completions 多模态示例按以下方式处理：

- 模型路由固定选择 Chat Completions；
- Codex Responses 输入自动转换为 `/api/v3/chat/completions`；
- `input_image` 转换为 `image_url`；
- 图片 URL 和文本顺序保持不变；
- 返回的 Chat Completions 流或非流响应转换回 Codex Responses。

这两个精确模型 ID 已加入官方模型覆盖表，避免在模型目录只声明“同时支持
Responses 和 Chat Completions”时选错协议。

`web_search` 的服务端工具结构目前只在原生 Responses 路径保证原样保留；不能假设
所有 Chat Completions 中转站都接受同样的内置工具声明。

## 图片工具策略

XwX Deck 不再因为历史上的某个 兼容服务 入口不支持 `image_gen`，就默认对所有
服务商关闭图片工具。

当前规则是：

- 自动识别和未知服务商默认保留 `image_gen`；
- 模型或服务商能力未知时允许实际尝试；
- 只有后台明确标记为不兼容的服务商才临时写入 `image_gen = false`；
- 从不兼容服务切换到其他服务时，会恢复用户原来的 `image_gen` 设置；
- 用户或其他软件在启用期间修改该字段时，外部修改优先；
- Gateway 也只对明确不兼容的服务商过滤 `image_gen` namespace。

输入图片能力和图片生成工具是两个不同维度：模型支持 `image_url` 不代表一定支持
Codex 的 `image_gen` namespace，反过来也一样。因此不会仅凭 `vision` 字段关闭或
开启图片生成工具。

## 当前认证边界

当前自动配置以 Bearer Token 为主，尚未实现：

- `x-api-key`；
- Azure 风格 `api-key`；
- AWS SigV4；
- Google OAuth；
- 任意自定义请求头；
- deployment 路径和 `api-version` 查询参数模板。

这些能力后续会作为内部 Provider Adapter 扩展，不会重新增加一组复杂的用户表单。

## 安全边界

- 密钥不会写入 Trace 请求头明文。
- 切换服务商时不会把旧服务商的 opaque 状态直接发送给新服务商。
- 服务商地址、协议或身份变化时会触发上下文可移植处理。
- 未验证的模型能力使用保守 fallback，不冒充官方能力。

## 官方参考

- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [火山方舟文档](https://www.volcengine.com/docs/82379)
