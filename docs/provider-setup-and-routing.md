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
| `src/main/smoke/packagedSmoke.ts` | 打包后的真实界面、九个客户端/服务入口、自定义表单、配置与 Trace 请求 |
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

界面可用 `npm run preview:web` 预览。预览数据适合检查布局与交互，真实 IPC 和请求以 Rust 原生打包回归为准。

## 按能力吸收时的边界

移植时可按界面入口、官方模型路由、切换别名、Trace 策略和退出保护分别审查，并带上相应回归。图标、共享注册表、IPC、主进程和 helper 的配套修改需要一起核对，不能只复制渲染组件。

本仓库保持独立应用身份、空初始连接和公开发布渠道；不引入配置同步、Excel、内部默认服务或历史别名。工具页与对话诊断已移除；会话历史管理仍保留。这些改动尚不表示已移植到任何其他仓库。

## 添加配置与 Coding Plan

设置 → 模型配置 → 添加配置，默认选择 API 服务；同一窗口可切换订阅账号或客户端下载。选中服务商后在同一页面预填名称、URL 和协议，Key 由用户填写，右侧「获取 Key」打开官方管理页。切换与关闭保留未保存草稿，保存不会替客户端选择连接或模型。

百炼 Coding Plan 使用独立 `sk-sp-` 密钥和 `https://coding.dashscope.aliyuncs.com/v1`（Chat Completions），参考[百炼官方说明](https://help.aliyun.com/zh/model-studio/coding-plan)。智谱 Coding Plan 的 Codex 专用入口为 `https://open.bigmodel.cn/api/v1`（Responses），参考[智谱 Codex 文档](https://docs.bigmodel.cn/cn/coding-plan/tool/codex)。套餐身份随配置保存，即使用户经由自定义代理修改地址，也不触发自动模型测试。套餐 Key 与普通 API Key 不混用，使用范围及额度以服务商条款为准。

保存仅确认本地配置写入；真实鉴权、套餐额度、所选模型权限需要在对应编程客户端发起新任务验证。协议转换继续通过本地 Trace Gateway，不能把「模型目录可访问」当成真实任务成功。


## ChatGPT 订阅账号

「订阅账号」支持添加多个 ChatGPT 注册账号，包括同一邮箱的不同工作区注册。系统浏览器登录使用 OpenAI 官方开源工具授权流程；只有身份签名和套餐使用权限都验证通过，才保存登录凭证。原有客户端登录不被导入或覆盖。新安装账号列表为空。

账号添加后出现在原有模型页面的服务列表，ChatGPT 与 Claude 可独立选择账号和模型。登录不会自动切换已有选择；目录离线或账号授权过期也不会替换用户选定的账号、模型。模型目录按所选账号读取，并过滤服务端标记隐藏的模型。

套餐请求必须开启 Trace：Rust Gateway 使用本机账号凭证调用公共 Responses 接口，并转换 Claude Messages 请求。OAuth 凭证不会写入网页、普通连接设置或客户端配置；按账号保存于应用目录的 `subscription-accounts.json`，Unix 权限为 `0600`，刷新令牌轮转采用串行与原子写入。停止 Trace 或崩溃恢复后还原启动前的客户端路由，不留下本地 Gateway 地址。

账号页面显示本机连接/需登录状态；「查看套餐用量」打开平台官方用量页面。未获得官方可读取的额度数据时，不显示推测的套餐名称、剩余额度或重置倒计时。退出登录会尝试撤销远端授权；远端无法确认时清除本机凭证并明确提示。账号注册身份及客户端选择保留，之后可重新登录。

已实现 ChatGPT 官方授权和 Grok 官方 CLI 独立账号路径。同时已实现 Copilot 设备授权、Claude Code 隔离登录和 Cursor 浏览器授权。Gemini 等其他账号适配尚未实现。独立 Responses compact 和 WebSocket 套餐调用暂不支持，客户端应使用 HTTP 流式请求。

参考 [OpenAI 注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[账号与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[模型与调用](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。`tools/native/subscriptions-test.mjs` 用隔离账号目录、本地 OAuth/JWKS 服务和实际 Gateway 请求覆盖登录、身份校验、多账号、刷新、跨客户端转换、退出与恢复。测试通过不代表已经完成用户真实账号的授权或验证其套餐额度。 Rust HTTP 请求沿用系统代理与环境代理设置；macOS/Windows 构建必须保留 reqwest 的 `system-proxy` 功能。登录失败页和应用内显示失败阶段及安全的错误原因，最近失败原因随账号凭证文件保留，但不保存授权码、PKCE、回调 URL 或远端错误正文。公开网络连通性可用 `auth-network-probe` 示例验证。

## Grok 与扩展目录

Grok 订阅登录通过用户安装的官方 Grok Build `grok login --device-auth` 完成。本产品为每个账号创建独立的 `grok-accounts/grok-*/`，不读取或覆盖 `~/.grok` 的账号；官方 CLI 拥有刷新凭证，本产品只为该账号的请求读取对应的短期访问凭证。重新登录先使用暂存目录，身份匹配后才替换原凭证；取消或失败清理暂存目录。账号元数据不含令牌。请求固定发往 `https://cli-chat-proxy.grok.com/v1`，版本由实际已安装 CLI 读取，不使用固定伪造版本。没有安装 CLI 时只显示官方安装入口。macOS 手动 HTTP/HTTPS 系统代理传给 CLI，显式环境代理优先；隔离测试不使用主机代理。

`tools/native/grok-subscriptions-test.mjs` 用隔离 CLI、本地授权服务和实际 HTTP 请求验证多账号、错账号重登、刷新、名称修改、Responses / Messages 转换、Codex custom / namespace 工具映射、秘密与请求头隔离、Trace 停止恢复。测试不是用户真实 Grok 套餐授权的证明。携带需转换工具的 Grok Responses 流目前在上游完成后生成客户端 SSE；普通文本流保持透传。

API 目录包含 33 个预设，其中 5 个为本机服务；客户端下载目录包含 25 个官方页面入口。国内外普通 API、套餐 Key 与账号授权保持各自明确身份。服务扩充不会创建连接或改变原有模型选择；中转继续使用自定义。每个 API 预设保留官方来源链接，所有新增预设在本地测试服务验证最终路径、协议和认证；不把这些回归视为每家服务商付费 Key 的线上验证。


## 订阅入口与 Magpie 对照

「订阅账号」只用于不填写 API Key 的账号授权。百炼、智谱、Kimi、MiniMax、Z.AI 的套餐 Key 只归「API 服务」，不在订阅页提供同名跳转。当前该页只列已实现的 ChatGPT 与 Grok。

[Magpie 的实现](https://github.com/yetone/magpie#sign-in-once-use-it-everywhere)将账号授权作为订阅来源：Claude 通过本机 Claude Code 与 MCP 工具桥接；其他账号通过各自的授权、刷新与请求适配接入。Claude、Copilot、Gemini 的完整接入在本产品仍未完成，不使用 API 表单或官网跳转代替登录。

官方用量快捷入口已逐一核对：ChatGPT 使用 `chatgpt.com/settings/usage`（与 Magpie 的开源应用授权入口一致），Claude 使用 `claude.ai/settings/usage`，Grok 进入 Settings > Usage，Copilot 进入账号设置中的 Usage，Cursor 进入 `cursor.com/dashboard`。这些是官网快捷入口，不会自动切换浏览器当前账号，也不代表 XwX Deck 已读取每个订阅账号的实时额度。来源：[Magpie](https://github.com/yetone/magpie/blob/main/internal/provider/chatgpt_api.go)、[Claude](https://support.claude.com/en/articles/9797557-usage-limit-best-practices)、[Grok](https://docs.x.ai/grok/faq)、[Copilot](https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage)、[Cursor](https://prod.cursor.com/help/account-and-billing/overages)。

CLI 镜像采用 [Agents CLI Mirror](https://github.com/Wangnov/agents-cli-mirror) 的 Codex / Claude 安装脚本，分别提供 Windows PowerShell 和 Mac / Linux shell；安装脚本读取当前版本清单并校验 SHA256。Gemini CLI、Qwen Code、OpenCode 使用 [npmmirror](https://npmmirror.com/) 的原厂 npm 包，命令仅为这一次安装指定 registry，不修改全局配置。镜像源为第三方；官方下载仍跳转原厂下载或安装页面。镜像可访问和元数据一致不代表已经在本机安装、验证所有系统或能登录服务。
