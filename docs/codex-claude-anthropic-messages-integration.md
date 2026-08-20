# Codex 接入 Claude：调研结论与 XwX Deck 集成

> 当前状态（2026-08-17）：本地实现与隔离回归已纳入当前核心套件；真实 ChatGPT/Codex Desktop + 公开服务商的端到端验收仍需按版本记录，因此不能仅凭源码测试声明发布就绪。公开验证层级见[GitHub 发布流程](github-release.md)。

## 技术结论

- [cc-switch](https://github.com/farion1231/cc-switch) 是当前协议覆盖最完整的 MIT 参考，覆盖 Responses 与 Anthropic Messages 的流式转换、工具、thinking/signature、多模态、prompt cache、usage 和错误边界。
- [opencodex](https://github.com/lidge-jun/opencodex) 是与 XwX Deck TypeScript 技术栈最接近的 MIT 架构参考，把 Anthropic Messages 作为一等 adapter。
- Codex++ 的桌面接管和供应商配置交互可作行为研究，但其 AGPL-3.0 实现不进入 XwX Deck。
- Codex 客户端继续固定 `wire_api = "responses"`；本地 XwX Gateway 按模型能力选择原生 Responses、Anthropic Messages 或现有 Chat Completions bridge，不使用 Chat Completions 作为 Claude 中间协议。

XwX Deck 的实现是独立 TypeScript 模块，参考上述 MIT 项目的协议行为和测试边界，没有复制 Codex++ 代码。

## 首期边界

- 只扩展现有 兼容服务，不增加多供应商页面、Anthropic API Key 字段或个人订阅 OAuth。
- 兼容服务 地址和密钥继续保存在 XwX Deck 设置中。开启“保留官方登录”时，现有 `auth.json` 不变，`xwx_deck` provider 只指向本地 Gateway，兼容服务 Key 仅由 Gateway 注入发往 兼容服务 的请求；关闭该选项时才临时投影到 `auth.json`，切回官方或重新开启后按逐字节备份恢复。
- Trace 只决定是否记录统一 Gateway 数据流。关闭 Trace 不停止 Claude 转发。
- `/responses/compact` 使用 XwX Deck 本地合成，不假设 Anthropic 上游提供 Responses Compact。

## 协议与路由

逐模型协议类型为：

```text
responses | chat-completions | anthropic-messages
```

路由优先使用 兼容服务 端点成员关系。2026-07-28 的一次目录快照中，Anthropic 目录内 31 个模型全部可调用，目录外旧名称规则额外匹配的 29 个模型全部无上游通道；这个计数只是当时的证据，不是当前服务保证。当前 Claude 自动列表仍以实时 Anthropic 端点集合为准，Gateway 将 Anthropic 请求发送到 兼容服务 `/anthropic/v1/messages`。

模型目录优先发布可追溯的上下文、输出上限、视觉、reasoning、工具和协议能力，不声明 Hosted Web Search、Image Generation、WebSocket 等 Gateway 无法兑现的能力。能力缺口使用带 `fallback` 来源的保守运行值，不在选择器逐行展示或禁用；已知非对话模型在生成目录前过滤。

## 转换覆盖

`src/main/trace/codexAnthropicBridge.ts` 直接执行 Responses 与 Anthropic Messages 转换：

- instructions、system/developer 历史、普通消息；
- function、custom、namespace、tool_search，以及工具结果配对和结构化错误；
- Anthropic `tool_use` / `tool_result` 与 Responses call ID 往返；
- 图片、PDF/文档的 data URL 与远程 URL；
- reasoning effort 到 adaptive thinking 或受限 thinking budget；
- thinking、redacted thinking 与 signature 的可回放 `xwxa1:` 信封；
- input/output、cache read、cache write token 与停止原因；
- 最多四个、5 分钟的受控 prompt-cache breakpoint，优先工具、system 和稳定历史。

Anthropic SSE 使用有状态、chunk-safe 的增量转换器。文本、thinking、签名和工具参数可交错到达；无 `message_stop`、半截 JSON、半截工具调用、Anthropic error event 或连接中断都会保留已接收的部分项并输出 `response.failed`。

## 已完成的隔离验收

- 单元覆盖文本、多模态、system/developer、并行工具、custom、namespace、tool_search、错误工具结果、usage/cache、thinking/signature/redacted thinking。
- 流式覆盖 chunk 边界、文本/thinking 交错、工具参数分块、多工具、无尾换行、无 `message_stop`、畸形事件、Anthropic error event 和真实代理断流。
- Gateway 集成覆盖 兼容服务 URL、认证隔离、Anthropic 版本头、真正增量首包、三协议连续热切换、客户端取消向上游传播、2xx 错误信封、请求侧残缺工具 JSON、Trace 协议标记、Trace 关闭仍转发、Claude 本地 Compact 与回放。
- 模型目录对 Claude 的 Messages 端点、工具、上下文和输出上限执行前置校验；浏览器预览验证了不可用原因、disabled/键盘行为以及 760×560 无横向溢出。
- 对应类型与隔离用例已纳入当前 `npm test`；不要在本文固化会随套件增长而过期的用例计数，发布结果以对应 GitHub Actions 和 Release 证据为准。

## 发布门槛

发布前仍必须使用真实 Codex CLI/Desktop 和真实 兼容服务 Claude 模型验证：

- 模型目录刷新与选择、普通编码和文件修改；
- Shell、MCP、custom/namespace/tool_search 和并行工具循环；
- 图片/PDF 输入、thinking/signature 连续回放、prompt cache usage；
- 自动 Compact、取消请求、会话恢复和长连接断流；
- 已经进入同一个 Gateway 的 Responses、Anthropic Messages、Chat Completions 模型可连续切换且无需重启 XwX Deck；官方 → 兼容服务 后，已加载任务若未切换连接，再由用户手动重启 ChatGPT；
- Trace 开关只影响记录，不影响调用结果。

任何真实能力元数据不足或 兼容服务 Messages 端点不可用的模型都必须前置拒绝，不能用伪成功事件降级。
