# Codex Desktop 第三方模型网关设计

> 当前状态（2026-09-26）：Responses、Chat Completions 与 Anthropic Messages 本地实现和隔离回归已纳入当前套件；真实 ChatGPT/Codex Desktop + 各公开服务商的端到端验收仍需按版本记录。公开边界见[独立仓库边界](public-release-boundary.md)。

## 目标与边界

目标是在不修改 Codex Desktop 本体的前提下，让 兼容服务 的 Responses、Chat Completions 与 Anthropic Messages 模型都能出现在原生模型选择器中，并在 Trace 关闭时继续正常调用。

每个连接拥有持久 Provider 身份与独立模型选择。两客户端可选择不同连接；不提供账号池、OAuth、远程网关或组合路由。

## 运行链路

```text
Codex Desktop / CLI
  -> $CODEX_HOME/config.toml (wire_api = responses)
  -> XwX 本地 Gateway
       -> Responses 模型：原样转发到 兼容服务
       -> Chat Completions 模型：Responses <-> Chat Completions 转换
       -> Claude 模型：Responses <-> Anthropic Messages 转换
       -> Trace 开启：记录同一条转发链路
       -> Trace 关闭：只转发，不记录
```

Gateway 复用当前 `TapProxy`。代理生命周期属于服务连接，记录生命周期属于 Trace；两者不再互相控制。

## 配置所有权

兼容服务 启用时，XwX Deck 管理以下字段：

- 顶层 `model_provider` 使用所选连接的持久 Provider ID；显式启用统一历史时使用 `xwx_deck`。
- 对应 `[model_providers.<id>]` 的连接、认证和 `wire_api = "responses"`。
- 顶层 `model_catalog_json` 在明确切换服务时更新；外部目录文件不修改或删除，自动刷新不接管外部配置。
- XwX 管理的目录文件 `$CODEX_HOME/xwx-compatible-catalog.json`。

兼容服务 的真实 URL 和密钥继续由 XwX Deck 设置保存。Codex 运行期间连接本地 Gateway；Gateway 再连接真实 兼容服务。默认保留现有 `auth.json`，兼容服务 Key 只由 Gateway 在转发到 兼容服务 时注入；关闭“保留官方登录”时，Key 才临时写入 `auth.json`，切回官方后原样恢复。

配置文件仍使用原子写入。Trace 的临时 overlay 与长期 Gateway 配置保持独立；外部软件改写用户自有字段时，XwX Deck 不进行整文件覆盖。

## 模型目录与协议选择

目录优先从 `$CODEX_HOME/models_cache.json` 克隆一条含 `base_instructions` 的原生模板，再改写模型身份和保守能力字段。没有模板时使用内置最小严格条目。

模型存在性与能力字段按 [兼容服务 模型能力维护](model-capability-maintenance.md) 的四层链路解析。逐模型协议选择顺序：

1. 服务声明 Responses 时优先直通。
2. 否则使用明确声明的 Chat Completions 或 Anthropic Messages；端点返回的模型成员关系也是声明证据。
3. 缺少声明时使用所选连接的默认协议，不按模型名或厂商猜测。
4. Claude 原生 Messages 不需要转换；仅需要转换的选择显示灰色「需转换」徽标。

协议在每个请求到达 Gateway 时根据 `model` 决定，不能依赖 XwX Deck 页面上最后一次选择，因此 Codex Desktop 内直接切换模型也能立即生效。

## Completion 兼容范围

第一批复用现有转换器，覆盖：文本与多模态输入、system/instructions、reasoning、函数工具、custom tool、namespace/tool_search、并行工具调用、JSON 输出、usage/cache token 与错误响应。

已知质量升级项：

- Chat SSE 增量转换，并处理客户端取消、背压和断流错误。
- 跨协议续接使用有界上下文和可移植检查点；缺少可用历史时明确报错，不伪造恢复。
- 不向第三方模型声明无法兑现的 OpenAI Fast tier、WebSocket、Hosted Web Search 或 Image Generation。

## Anthropic Messages 兼容范围

独立转换模块直接在 Responses 与 Anthropic Messages 之间转换，不经过 Chat Completions。当前覆盖 instructions、system/developer 历史、多模态输入、PDF/文档、function/custom/namespace/tool_search、工具结果及错误、call ID、thinking/redacted thinking/signature 回放、reasoning effort、prompt cache、usage/cache token、停止原因和 Anthropic 错误信封。

Anthropic SSE 使用按块增量转换：文本、thinking、签名和工具参数随上游事件输出；缺少 `message_stop`、半截 JSON、半截工具调用和连接中断会生成明确的 `response.failed`，不会伪造完成事件。`/responses/compact` 仍由 XwX 本地合成摘要，Claude 上游只执行普通 Messages 摘要回合。

实现协议行为参考 MIT 许可的 [cc-switch](https://github.com/farion1231/cc-switch) 与 [opencodex](https://github.com/lidge-jun/opencodex)，采用 XwX Deck 自有 TypeScript 模块结构。Codex++ 仅用于行为研究，没有复制其 AGPL-3.0 代码。

## 当前实现结果

- 复用 `TapProxy` 建立常驻 Gateway；关闭 Trace 只停止落盘，不中断模型转发。
- 启用兼容服务时生成 `$CODEX_HOME/xwx-compatible-catalog.json`，明确选择连接后写入目录指针，保留外部目录文件。
- Codex 使用 Responses；Gateway 按逐模型声明选择直通或协议转换，缺少声明时使用连接默认值。
- 关闭窗口隐藏管理器，所需 Gateway 继续运行；菜单、托盘、Dock 和 Cmd+Q 退出执行字段级恢复与停服。恢复失败或客户端仍依赖本地端口时取消退出并保留 Gateway。所选 Provider 不自动切回官方；转换模型仍需要本地 Gateway。
- 当前实现通过源码级隔离回归不等于真实 ChatGPT + 服务商三协议端到端通过，也不证明任一平台安装包已经完成公开发布验证。制品边界统一以[GitHub 发布流程](github-release.md)和对应 Release 证据为准。
- `model_catalog_json` 是启动时读取的配置；目录生成或模型列表变化后，已运行的 Codex Desktop 仍需重启才能可靠刷新原生选择器。
- 能力未核验的对话条目仍进入 Codex 目录并允许用户选择；上下文最终使用 256K fallback，未知输出使用 8192 token，未知工具能力按兼容模式尝试。模型选择器只显示模型名，不展示逐行能力诊断；embedding、图片生成、OCR 和没有 Codex 转换链路的 Gemini-only 模型在目录生成前过滤。

### Compact 兼容

本节只说明第三方协议形状；Codex 何时压缩、rollout 是什么、明文检查点如何替代 foreign opaque 状态，以及官方/兼容服务 双向转换的完整说明见[Codex 上下文压缩、Rollout 与跨上游可移植性](codex-context-compaction-portability.md)。

- `/v1/responses/compact` 使用独立路由，不再被普通 `/responses` 的路径转换吞掉。
- 模型目录只有明确发布 `supports_responses_compact`、`responses_compact` 或 `/responses/compact` endpoint 时才原样透传；仅支持 Responses 不等于支持 Compact。
- 其他模型使用当前模型执行一次无工具、非流式的摘要回合。Chat 模型走 `/chat/completions`，Responses 模型走普通 `/responses`。
- v1 Compact 返回近期用户消息与交接摘要组成的替换历史；v2 `compaction_trigger` 返回且只返回一个 `compaction` output item。
- 合成摘要使用 `xwxc1:` + Base64 的透明信封。后续 Chat 模型会解码为普通交接上下文；真实 OpenAI 加密内容无法解密时只注入明确的不可读提示，不伪造原始状态。

## 验收矩阵

- Codex Desktop 原生选择器显示 兼容服务 模型；刷新后无陈旧目录。
- Responses：GPT 流式、非流式、工具调用、错误响应。
- Chat Completions：DeepSeek/Kimi/GLM/Qwen/MiniMax 的文本、reasoning、工具调用与 usage。
- Anthropic Messages：Claude 文本、thinking/signature、并行工具、多模态、Compact、断流、取消与会话恢复。
- 在 Codex Desktop 内连续切换不同协议模型，无需回到 XwX Deck。
- Trace 开/关不改变模型服务；关闭时不新增 trace，调用仍成功。
- 兼容服务/官方服务切换、XwX Deck 重启、端口残留和外部配置修改可恢复。
- `CODEX_HOME` 自定义目录、用户自有 `model_catalog_json`、损坏/缺失模型缓存均安全降级。
- 隔离 smoke、类型检查、真实 Codex Desktop + 真实 兼容服务 端到端验证通过后才可声明发布就绪。
