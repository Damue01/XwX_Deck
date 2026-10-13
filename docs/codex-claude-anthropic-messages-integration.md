# Codex 接入 Claude：调研结论与 XwX Deck 集成

本文保留 2026-08-17 的协议研究与首期设计。
历史范围和回归描述不代表当前公开版的全部能力。
当前后端已统一为 Rust，支持范围见 [服务配置与路由](provider-setup-and-routing.md)。
最新验收见 [公开版同步记录](public-sync-acceptance.md)。

## 历史研究结论

- [cc-switch](https://github.com/farion1231/cc-switch) 是当时采用的 MIT 协议参考，覆盖 Responses 与 Anthropic Messages 的流式转换、工具、thinking/signature、多模态、prompt cache、usage 和错误边界。
- [opencodex](https://github.com/lidge-jun/opencodex) 是早期 TypeScript 实现采用的 MIT 架构参考，把 Anthropic Messages 作为一等 adapter。
- Codex++ 的桌面接管和供应商配置交互可作行为研究，但其 AGPL-3.0 实现不进入 XwX Deck。
- Codex 客户端继续固定 `wire_api = "responses"`；本地 XwX Gateway 按模型能力选择原生 Responses、Anthropic Messages 或现有 Chat Completions bridge，不使用 Chat Completions 作为 Claude 中间协议。

早期实现为独立 TypeScript 模块。研究参考协议行为与测试边界，没有复制 Codex++ 代码。当前实现使用 Rust 原生模块。

## 历史首期边界

- 只扩展现有 兼容服务，不增加多供应商页面、Anthropic API Key 字段或个人订阅 OAuth。
- 兼容服务 地址和密钥继续保存在 XwX Deck 设置中。开启“保留官方登录”时，现有 `auth.json` 不变，`xwx_deck` provider 只指向本地 Gateway，兼容服务 Key 仅由 Gateway 注入发往 兼容服务 的请求；关闭该选项时才临时投影到 `auth.json`，切回官方或重新开启后按逐字节备份恢复。
- Trace 只决定是否记录统一 Gateway 数据流。关闭 Trace 不停止 Claude 转发。
- `/responses/compact` 使用 XwX Deck 本地合成，不假设 Anthropic 上游提供 Responses Compact。

## 历史协议与路由

逐模型协议类型为：

```text
responses | chat-completions | anthropic-messages
```

路由优先使用 兼容服务 端点成员关系。2026-07-28 的一次目录快照中，Anthropic 目录内 31 个模型全部可调用，目录外旧名称规则额外匹配的 29 个模型全部无上游通道；这个计数只是当时的证据，不是当前服务保证。当时的 Claude 自动列表以 Anthropic 端点集合为准，Gateway 将 Anthropic 请求发送到 兼容服务 `/anthropic/v1/messages`。

模型目录优先发布可追溯的上下文、输出上限、视觉、reasoning、工具和协议能力，不声明 Hosted Web Search、Image Generation、WebSocket 等 Gateway 无法兑现的能力。能力缺口使用带 `fallback` 来源的保守运行值，不在选择器逐行展示或禁用；已知非对话模型在生成目录前过滤。

## 转换覆盖

当前 [protocol.rs](https://github.com/Damue01/XwX_Deck/blob/main/src-native/src/protocol.rs) 处理协议转换。
请求转发入口为 [core.rs](https://github.com/Damue01/XwX_Deck/blob/main/src-native/src/core.rs)。
续接由 [continuation.rs](https://github.com/Damue01/XwX_Deck/blob/main/src-native/src/continuation.rs) 处理。
以下为协议研究要求，具体边界应核对当前实现与回归：

- instructions、system/developer 历史、普通消息；
- function、custom、namespace、tool_search，以及工具结果配对和结构化错误；
- Anthropic `tool_use` / `tool_result` 与 Responses call ID 往返；
- 图片、PDF/文档的 data URL 与远程 URL；
- reasoning effort 到 adaptive thinking 或受限 thinking budget；
- thinking、redacted thinking 与 signature 的可回放 `xwxa1:` 信封；
- input/output、cache read、cache write token 与停止原因；
- 最多四个、5 分钟的受控 prompt-cache breakpoint，优先工具、system 和稳定历史。

Anthropic SSE 使用有状态、chunk-safe 的增量转换器。文本、thinking、签名和工具参数可交错到达；无 `message_stop`、半截 JSON、半截工具调用、Anthropic error event 或连接中断都会保留已接收的部分项并输出 `response.failed`。

## 历史隔离验收

- 单元覆盖文本、多模态、system/developer、并行工具、custom、namespace、tool_search、错误工具结果、usage/cache、thinking/signature/redacted thinking。
- 流式覆盖 chunk 边界、文本/thinking 交错、工具参数分块、多工具、无尾换行、无 `message_stop`、畸形事件、Anthropic error event 和真实代理断流。
- Gateway 集成覆盖 兼容服务 URL、认证隔离、Anthropic 版本头、真正增量首包、三协议连续热切换、客户端取消向上游传播、2xx 错误信封、请求侧残缺工具 JSON、Trace 协议标记、Trace 关闭仍转发、Claude 本地 Compact 与回放。
- 模型目录对 Claude 的 Messages 端点、工具、上下文和输出上限执行前置校验；浏览器预览验证了不可用原因、disabled/键盘行为以及 760×560 无横向溢出。
- 上述结果属于当时的实现。当前使用 `tools/native/protocol-test.mjs` 和 `tools/native/portability-test.mjs` 重跑验证。历史结果不能替代最新源码或制品验收。

## 发布门槛

发布前仍必须使用真实 Codex CLI/Desktop 和真实 兼容服务 Claude 模型验证：

- 模型目录刷新与选择、普通编码和文件修改；
- Shell、MCP、custom/namespace/tool_search 和并行工具循环；
- 图片/PDF 输入、thinking/signature 连续回放、prompt cache usage；
- 自动 Compact、取消请求、会话恢复和长连接断流；
- 已经进入同一个 Gateway 的 Responses、Anthropic Messages、Chat Completions 模型可连续切换且无需重启 XwX Deck；官方 → 兼容服务 后，已加载任务若未切换连接，再由用户手动重启 ChatGPT；
- 停止 Trace 后验证字段恢复与实际直连。外部冲突、本地依赖和旧客户端缓存分别处理。

未知能力不能撤销用户的明确选择。实际协议无法表达或上游拒绝时，返回明确错误，不能用伪成功事件降级。
