# 通用客户端 Trace 接入

## 客户端与配置归属

模型页的客户端标签不是自动接管承诺。Claude / ChatGPT 保留原接管链路；OpenCode、Gemini CLI、Qwen Code、Pi、MiMo Code、Crush、Qoder、Droid、CodeBuddy Code、WorkBuddy 增加独立配置适配。其他允许设置 API URL 的客户端使用独立地址与本机占位密钥 `xwx-deck`，上游凭证由 Gateway 提供，不复制到客户端。

新安装没有服务或接管。只有用户明确选择服务与模型、客户端已安装并启用时才修改对应客户端的配置。启动恢复用户已保存的 Trace 意图；明确关闭后不会在下次启动擅自开启。项目配置、项目 `.env`、进程环境变量可能覆盖全局设置，目前不自动改写这些层。

每个客户端保存独立的服务、模型和参与状态。普通服务切换保留已经开始的请求快照，新请求使用新服务；暂停仅移除该客户端的入口并恢复它的原连接。停止 Trace 恢复全部受管字段后才关闭监听。

JSON / JSONC 与 Gemini `.env` 采用字段级修改。接管前预览摘要必须与写入时一致；恢复日志先于客户端文件写入。原文件无其他变化时按原字节恢复，否则只还原受管字段并保留外部设置。外部修改了受管字段时拒绝覆盖，保留恢复日志和 Gateway，并报告冲突。符号链接和重复字段不自动接管。

## 协议与 Trace 证据

独立地址为 `/clients/{client}`；Chat / Responses / Messages 使用 `/v1`，Gemini 使用 `/v1beta/models/{model}:generateContent` 或 `:streamGenerateContent`。没有启用的客户端地址返回 404，避免借用其他客户端的服务。会话与 Responses 续接缓存按客户端隔离。

Chat Completions、Responses、Messages、Gemini 生成请求复用现有 Gateway、订阅授权和捕获链路。原生 Chat 请求直通；跨协议转换文本、系统提示、图片、工具调用与结果及可表达的推理内容。流式转换实时输出，并在完整结束后补全最终内容；不完整的流不能伪造成功完成事件，不重放已输出的请求。

Trace 分开记录原始客户端请求、规范化请求、实际上游请求、实际上游响应与转换后的客户端响应。来源显示客户端名字；协议变化在查看器标题显示，详细转换说明保存在日志中。敏感授权头脱敏。会话摘要取原始客户端第一条用户提示。

阅读视图的 Messages / System / Tools 只解析本次 `request.body`，不从之前的 Trace 或续接缓存拼入旧正文。Responses 字符串输入和 Gemini 图片、未识别内容块保留；本地兼容摘要与不透明上游压缩项分别标识。日志中的 `upstream.requestBody` 才是适配、续接后实际发送的内容，HTTP 与 WebSocket 均分开记录。cURL 使用实际上游地址与对应请求体，不混用客户端原协议；WebSocket / Connect 不伪装成可直接重放的 HTTP JSON。JSON 会被解析、排版，阅读视图并非字节级抓包；SSE 阅读视图组装文本与工具增量，原始上游流另外保留。通用接口转换后的响应标记为 assembled，不冒充逐字原始流。

Gateway 的 `continuations` 保存有限的可携带上下文（单条 16 MB、总计 64 MB、最多 512 个文件、约 24 小时），用于 previous_response_id 或切换服务的续接。它不是服务商的 KV 张量缓存，也不为 Trace 阅读区补造历史。官方不透明压缩项无法本地解密；无法恢复的跨服务压缩明确失败。兼容服务的压缩使用所选模型生成摘要，再以 xwxc1 编码返回；这是有损的可携带摘要，不是官方加密压缩或 KV cache。压缩本身不删除以前的 Trace；Trace 容量自动清理与用户手动删除是独立操作，续接缓存到期也不修改历史 Trace。

计数继续使用现有 `storage.rs` 的上游用量解析和价格表，转换后的客户端 usage 不重复计费。输入、输出、缓存读写分别保留；缺少可信价格或用量时沿用原有未知/不完整状态，不补造额度或费用。「最新请求」取按开始时间排序的最后一条统计记录；图表从后端保留的最近 1,000 条请求中按顺序绘制有 token 的请求，可用宽度决定显示多少根相邻柱子；空闲时间和 0 token 请求不推动图表，不按分钟分组，也不把时间间隔画成空隙。悬停仍显示原始请求时间和 token；空闲时不持续重绘。长时间没有新请求时不会将已有最后一条记录显示为 0。原生 Anthropic `count_tokens` 仅转发预估，不计入生成统计；跨协议 count 与 Gemini count 尚未实现，明确返回 501。

Gemini `topK` 没有跨协议等价字段，转换记录明确标注省略。指定 thinkingBudget、结构化输出约束、thoughtSignature 等尚不能无损表达的内容明确失败；自动预算和可见推理摘要可转换。原生 Gemini 上游、平台特有非生成接口及任意客户端专属协议不在当前接管能力内。

## 验证边界

`tools/native/universal-gateway-test.mjs` 使用真实 Rust RPC、隔离客户端目录与本地 HTTP 上游，验证请求、流、工具、缓存用量、已有价格、独立切换、停止恢复、外部修改、崩溃恢复和无默认连接。订阅回归覆盖通用客户端沿用 ChatGPT / Copilot 授权链路。`tools/native/universal-native-ui-test.mjs` 在真实桌面 WebView 中操作客户端标签、服务菜单、关闭管理面板、开启捕获和暂停单个来源，并用本地上游生成验证实际用量和价格。

`node tools/native/trace-chart-test.mjs` 验证历史跨越原时间窗口、1,000 条记录、排序、单条与空历史、无效数据及空闲时间不会隐藏请求。点阵保留平顶、直上直下的柱状风格，每根柱子对应一条真实请求，相邻柱子无额外间隙，不插值、不按时间聚合，也不添加首尾归零曲线。计数与悬停仍取原请求。桌面回归也检查“最新请求”与上游用量一致，并在时钟推进后保留图表范围。`portability-test.mjs` 验证压缩、HTTP 与 WebSocket 分开记录原始请求及补回后的上游上下文。

这些回归不运行正式 OpenCode / Gemini / Qwen CLI，不证明平台真实套餐权限、项目环境覆盖或所有版本的运行缓存行为。正式扩展支持需使用真实客户端完成一轮生成、工具续接、取消、停止 Trace 后直连验收。现有 Claude 订阅 HTTP 适配也没有在本次替换为 Magpie 的 Claude CLI / MCP bridge。


## 扩展客户端目录

本轮增加 Pi、oh-my-pi、Crush、Qoder、Droid、GitHub Copilot CLI、Cursor CLI、MiMo Code、WorkBuddy、CodeBuddy Code、Hermes Agent、Antigravity CLI、OpenChamber、T3 Code 的官方下载/安装页面、离线图标和可执行文件检测。Cursor Desktop/CLI 共用产品入口与 Cursor 模型页签，详情内分别提供下载链接；Copilot CLI 与 Copilot 订阅账号是两个不同能力。

Pi 保留已有限定模型列表并追加所选模型；Crush 同时修改配置中的服务和数据文件中的 large/small 模型，避免旧模型参数附着到新模型；Droid/CodeBuddy/WorkBuddy 保留已有自定义模型并追加 Deck 模型。所有自动配置均有字段归属账本、原文备份、预览摘要和外部冲突保护。WorkBuddy 的任务选择存在应用内部，Deck 只把模型加入列表，用户还需要在 WorkBuddy 任务中选择它。配置目录环境变量只接受可明确定位的绝对路径或 home 路径；不扫描项目或执行配置里的命令。

模型页默认只显示模型服务与默认模型；已有手动连接的客户端仅保留默认折叠的「连接设置」，里面是可复制地址、密钥和官方说明链接。不再展示或生成启动命令、配置片段和配置文件路径。模型连接管理不包含终端、任务运行或 CLI 自身的其他设置。

客户端目录保留全部下载入口；仅有可恢复配置适配的已安装客户端提供新建模型页签按钮。用户先前明确添加的客户端与路由保留，仍可在管理面板移除。Cursor CLI 没有任意 API 接管适配，不以通用 URL 冒充已实现协议桥接。手动接入停止后仍需在客户端撤销本地地址；Gateway 不能恢复它未写入的字段。镜像入口默认折叠，CLI 安装说明仅通过官方下载链接打开。

本轮 `tools/native/expanded-clients-test.mjs` 在隔离目录覆盖 14 个客户端的安装检测/模型页添加，7 个新自动配置格式的恢复，13 个独立来源的实际本地 HTTP 请求及 Chat/Gemini 到 Responses 上游转换。后台 Token/缓存/费用计算公式未改动。该回归使用格式夹具和 HTTP 测试服务，尚未运行这些正式客户端或验证真实套餐；不能将它描述为所有客户端完整端到端验收。

原生桌面在 Trace 记录更新后发送状态事件，让统计界面读取后台最新用量；不只依赖 WebKit 定时器。前端轮询清理时同时重置计时器引用，重新进入捕获页可重新启动轮询。状态事件不重新捕获请求，也不重复计费。

参考：[Magpie agents](https://github.com/yetone/magpie/tree/main/internal/agent)、[Pi 模型配置](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md)、[Copilot CLI BYOK](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)、[VS Code Custom Endpoint](https://code.visualstudio.com/docs/agent-customization/language-models)、[Antigravity CLI](https://www.antigravity.google/docs/cli/install/)。品牌资产来源和许可证保留在 THIRD_PARTY_NOTICES.md。
