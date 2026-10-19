# Provider 切换修复验收

## 范围与环境

2026-10-19 从远端更新至 `c6496fe91960ffd3ed8e0db9532eb41babaa8e13`。
本轮同时在 macOS arm64 和 Windows x64 联调。
Windows 原生 Harness 补测发现不同型号的旧会话引用失效。
两端均已复现、修复，并在真实桌面原会话中验证 A→B→A。
所有生成请求使用官方客户端、隔离配置和本地服务。
API 密钥和订阅令牌均为合成值，没有复制日常凭据。
未替换日常应用，未推送、安装或发布更新。

## 修复内容

Claude 从 API 连接切到订阅时提前返回，跳过旧配置恢复。
现在先移除受管地址、密钥和角色模型，再记录订阅选择。
Trace 关闭、开启、停止和重启均检查原配置恢复。
外部修改仍保留，并阻止覆盖。

认证期间的启动退出在修复前已复现。
日志为“试验目录已被另一个运行中的进程占用”。
多个认证助手交接时，租约标记会短暂消失。
启动程序据此误判占用者，随后退出。
现在保留已观察到的认证租约状态，继续原有有界等待。
普通重复启动仍拒绝占用同一目录。
这解释了已复现的启动退出，不代表所有真实厂商退出原因均已覆盖。

实际请求与旧会话续接又发现以下问题，均已修复。

| 客户端 | 问题 | 修复 |
| --- | --- | --- |
| WorkBuddy、CodeBuddy | 缺少默认模型，或把本地模型别名传给上游 | 补齐默认选择，只解析确实由本产品生成的默认别名 |
| Qwen | 把自定义服务名写成认证协议，客户端启动失败 | 使用其支持的 OpenAI 认证协议 |
| Cline | 启动时更新模型能力，被误判为外部配置冲突 | 仅管理路由和选择，保留客户端维护的能力字段 |
| VS Code | 恢复后重建空配置，被误判为外部修改 | 仅将完全空的对象、数组与缺失文件视为等价 |
| Kimi、Droid | 切换时删除旧会话保存的模型目录 ID | 保持本地目录 ID 稳定，精确上游模型独立更新 |
| OpenCode、MiMo | 旧会话引用的模型目录键随切换消失 | v1 配置保持 `selected` 键稳定，以 `id` 保存精确上游模型 |
| Grok | 流结束帧缺时间字段；旧会话目录键随切换消失 | 补齐结束和用量帧字段，保持目录键稳定 |
| DeepSeek Harness | 桌面原会话引用了随型号切换消失的模型 ID | 保持受管 ID 稳定，专属入口只转换该精确 ID，其他显式值保持不变 |

OpenCode v2 配置保留现有适配和恢复行为。
本轮实际客户端验证的是其 v1 配置，不外推到未实测的 v2 消费行为。

## 实际客户端矩阵

切换通过要求 A→B→A 实际请求到达目标服务。
逐次核对上游路径、凭据、精确模型和可见回答。
原会话续接另查后续请求是否携带前轮回答。
Codex 的 B 为本地 ChatGPT 官方订阅夹具。
Claude 同时实测 ChatGPT 订阅转接与 Claude OAuth 订阅。
其他 A、B 为两个本地 API 服务。
Grok 的原生辅助模型请求另行记录。

| 客户端 | Mac 版本与实际结果 | Windows 版本与实际结果 | 续接范围 |
| --- | --- | --- | --- |
| Codex | 0.162.1，CLI 通过 | 0.163.0-alpha.10.2，CLI 通过 | 两端同一线程 |
| Claude Code | 2.1.228，CLI 通过 | 2.1.303，CLI 通过 | 两端同一会话，另测 Claude OAuth 及重启 |
| DeepSeek Harness | 0.2.0-rc.2，CLI 和原生桌面通过 | 0.2.1-rc.2，原生桌面通过 | 不同型号自动更新菜单，同一聊天续接 |
| WorkBuddy | 2.156.0，内置 CLI 通过 | 2.161.0，内置 CLI 通过 | 同一会话，Deck 重启后实际续接 |
| CodeBuddy Code | 2.169.0，CLI 通过 | 2.169.0，CLI 通过 | 两端同一会话 |
| Qwen Code | 0.25.2，通过 | 0.25.2，通过 | 两端同一会话 |
| Gemini CLI | 0.64.0，通过 | 0.64.0，通过 | 两端同一会话 |
| Pi | 1.2.0，通过 | 1.2.0，通过 | 两端同一会话，另测停止后的直连 |
| OpenCode | 1.19.3，通过 | 1.19.3，通过 | 两端同一会话，v1 配置 |
| MiMo Code | 0.1.15，通过 | 0.1.15，通过 | 两端同一会话 |
| Kimi Code | 2.2.0，通过 | 2.2.0，通过 | 同一会话，Deck 重启后实际续接 |
| Cline | 3.0.73，新会话切换通过 | 3.0.73，新会话切换通过 | 旧会话 CLI 报错，ACP 要求厂商认证 |
| Crush | 0.98.1，通过 | 0.98.1，通过 | 两端同一会话 |
| Droid | 0.244.0，通过 | 0.244.0，通过 | 同一会话，Deck 重启后实际续接 |
| Grok Build | 1.0.62，ACP 通过 | 1.0.62，ACP 通过 | ACP 同进程原会话；CLI 跨进程恢复失败 |
| Copilot CLI | 1.0.98，手动接入后通过 | 1.0.98，手动接入后通过 | 两端同一会话 |
| oh-my-pi | 18.12.2，手动接入后通过 | 18.12.2，手动接入后通过 | 两端同一会话 |
| Goose | 1.55.0，手动接入后通过 | 1.55.0，手动接入后通过 | 两端同一会话 |
| Hermes Agent | 源码 fd905d292693，手动接入后通过 | 源码 5fc490e2b341，手动接入后通过 | 两端同一会话 |
| VS Code | 1.142.0，Copilot 0.70，通过 | 1.126.0，Copilot 0.54.0，通过 | 官方扩展模型接口；未声明原生 Chat 续接 |
| Zed | 1.24.2，原生窗口通过 | 1.24.2，工作区信任提示受阻 | Mac 原生同一聊天；Windows 无模型请求 |
| Qoder | 1.1.73，登录受阻 | 1.1.73，登录受阻 | 两端均无模型请求 |

Mac 共 21 个客户端完成实际切换，Qoder 因账户要求受阻。
Windows 共 20 个客户端完成实际切换，Qoder 和 Zed 分别因登录与权限提示受阻。
Mac 有 19 个客户端验证原会话，Windows 有 18 个。
Cline 新会话与 VS Code 模型接口另行计数。
手动接入项不表示自动配置支持。
桌面包内置 CLI 的结果不代表该产品桌面聊天窗口验收。

## 旧会话与账户限制

Grok 的 ACP 同进程会话已完成 A→B→A。
CLI 跨进程 `--resume` 在第三轮仍恢复内建模型。
该失败有独立记录，不能用 ACP 成功替代 CLI 恢复结论。
没有改写原生历史、覆盖所有内建模型或向外部服务发送推理请求。

Cline 3.0.73 的 `--json --id` 在发送请求前拒绝已有提示词。
其 ACP 初始化只提供厂商登录方式，未开放本轮 BYOK 凭据路径。
因此只确认三轮新会话实际切换，未确认旧会话续接。
同类问题见 [Cline 上游记录](https://github.com/cline/cline/issues/10856)。

Qoder 隔离配置报告未登录，实际生成请求数为零。
其自定义模型流程要求登录及相应计划，本轮未提供此账户。
按 [Qoder 官方说明](https://docs.qoder.com/cli/custom-models) 保留原生向导流程。
没有手工写入未受支持的配置来绕过账户检查。

## Mac 原生界面、配置与认证

最终固定候选为 `test-results/provider-switch-final-mac`。
SHA-256 为 `c19b9fd73a979e506519514cf7efb6a0b89c97f60339369d01045069d707eb94`。
固定时源码指纹为 `8ef21d33bf8732ebed9a2e837a9b9e1d9e528aaff68929c2e7c41141db741a13`，共 587 项输入。
固定后修正两处回归夹具，并整合跨平台测试入口。
产品代码和原生资源未改变。
整合后所有可运行 CLI、8 轮原生界面和 VS Code 实际扩展请求再次通过。
当前测试源码指纹为 `b1aafd34fc516162f4fceab4470a7ad7f8226117f975cec61c246d69f1a14a95`。
后续构建文件与本次固定候选分别保留，不混用哈希。

原生 WebView 实际操作 Codex、Claude 的服务和模型控件。
两者分别完成同一会话 A→官方订阅 B→A。
从 UI 停止 Trace 后，两者原会话继续直连 A。
共 8 轮实际客户端请求通过，重启后保存的选择仍保留。

固定候选还补测了真正的 Claude OAuth 适配路径。
授权使用本地合成私有目录夹具，生成使用真实官方 Claude CLI。
原会话完成 API A→Claude OAuth B→A。
关闭 Trace 后再切 OAuth，配置精确还原且重启不恢复旧 API。
再次开启 Trace 后，原 Claude 会话继续走 OAuth B。
共 4 轮实际请求通过，不代表真实厂商登录已验收。

另有人工原生界面 9 轮补充验证。
Trace 关闭时切 Claude 至官方订阅，配置精确恢复为原始外部字段。
退出重开后没有旧 DeepSeek 地址、密钥和角色模型。
再次启动 Trace，原 Claude 会话继续走订阅 B。
该补充记录单独绑定 `b1f8092c5a3029e487de229932dfa3f7aa98b3e9cfc0a919e83c39f392121509`，不冒充最终候选结果。

Harness 桌面修复前在两端实际复现。
Mac 第二轮报 `UNKNOWN_MODEL`，没有 B 上游请求。
修复后保持同一原生聊天，菜单自动显示 A、B、A 的精确型号。
三轮上游的地址、密钥、型号正确，后两轮携带前轮回答。
没有新建聊天、手动重选模型或改写原生历史。
停止 Trace 后恢复配置，自有桌面进程已退出。

VS Code 使用真实官方扩展宿主，未伪造登录或修改官方扩展。
三轮实际请求和停止后的恢复、重启选择保留均通过。
首次试验使用扩展测试模式，官方扩展主动关闭模型能力，已保留失败证据。
改为普通开发扩展宿主后按实际 BYOK 路径验证。
Zed 通过官方 CLI 和终端启动，保持项目受限模式。
同一原生聊天中完成 A→B→A，未授予工作区信任，也未把测试密钥存入日常钥匙串。

认证覆盖真实安装 Codex 执行凭据命令及本地 Responses 请求。
关闭后重启 6 轮，每轮并发 4 个认证助手。
检查每轮仅轮换一次、旧绑定不串账户、原始登录文件和选择保留。
超时调用的后台刷新仍持久化，下一次调用没有重复轮换。
本轮未执行真实厂商登录、在线刷新或服务端撤销授权。

## 自动检查与证据

Mac 的 201 项 Rust 单测、格式和严格静态检查通过。
103 个后台套件复核完成，含 1 项 Windows 平台跳过。
最终候选首次全量运行有一项回归夹具失败。
独立 OpenCode 作用域断言在未选择服务时发送请求，得到真实的 404。
补齐该独立前置状态后，路由回归与受管适配两项复测通过。
VS Code 另一独立场景也补齐恢复夹具后的所有权确认。
这些修正没有修改产品代码或放宽失败断言。

中间候选另有两项历史失败，记录保留在 `provider-switch-pre-harness-fix`。
旧模型键替换没有改变文件，已改用稳定键并断言文件必须变化。
另一次元数据来源断言出现 `provider` 与 `protocol` 不一致。
产品代码未改，单独、整组和最终候选全量运行均通过。
该历史失败的精确原因尚未证实，不将其记为已修复产品缺陷。
公共边界检查进程曾退出 133，重跑通过，原日志仍保留。

编译、构建回归、公共边界、运行时边界、工作流和测试入口检查通过。
通用旧原生冒烟另有引导选择器失败，未将整个原生 UI 套件记为通过。
本轮专用切换原生 UI 流程已实际通过。

主要本地证据位于 `test-results`。

| 记录 | 内容 |
| --- | --- |
| `provider-switch-both-platforms.json` | 双平台完整机器可读结果与限制 |
| `provider-final-windows-acceptance.json` | Windows 最终完整回传报告 |
| `provider-final-mac-acceptance.json` | Mac 完整机器可读结果 |
| `provider-switch-final-mac-manifest.json` | 固定候选、源码指纹和产品文件摘要 |
| `provider-final-backend-summary.json` | 最终套件结果及全部重试来源 |
| `provider-final-backend-attempts.json` | 首次失败与重试索引 |
| `live-client-switch-<client>.json` | 各客户端实际路径、模型、凭据和会话 |
| `live-client-switch-harness-desktop-mac.json` | Harness 原生桌面不同型号、同会话续接与真实上游 |
| `live-client-switch-harness-desktop-mac-before.json` | 修复前原生桌面 `UNKNOWN_MODEL` 失败及截图 |
| `native-provider-switch.json` | 原生 WebView 操作及 8 轮实际请求 |
| `mac-ui-claude-official-cleared.json` | 人工界面切官方后的原配置与重启 |
| `live-client-switch-claude-oauth.json` | Claude OAuth 原会话切换、旧配置清理及重启后的实际请求 |
| `native-auth-summary.json` | 并发认证与真实 Codex 凭据命令 |
| `native-pi-client.json`、`native-opencode-client.json` | 生成配置、停止直连、恢复及重启 |
| `provider-final-claude-restart.log` | 固定候选的 Claude 清理、重启与本地订阅请求 |

## Windows 最终复核

最终 EXE 位于该端隔离目录的 `test-results/provider-switch-expanded/windows-frozen.exe`。
SHA-256 为 `5f3106dd62031a2119a9c1ef56a919dcc01d6def183b26749ab0072c30bc6f0f`。
源码指纹为 `dccaa6755fefd3cef192ae589fb63270ec3994c615c9cb2c92a0b435952c7da6`，共 587 项输入。
该端测试期间源码和固定 EXE 均保持不变。
Mac 已取回完整结果，记录为 `test-results/provider-final-windows-acceptance.json`。
八个 Rust 核心文件经换行规范化后的 SHA-256 与 Mac 一致。

20 个客户端完成实际请求切换，18 个验证原生会话续接。
Cline 三轮新会话、VS Code 官方扩展模型接口分别计数。
Qoder 与 Zed 没有生成请求，不记为通过。
Windows Zed 已打开原生工作区，出现 `Unrecognized Project` 提示。
该端 Computer Use skill 要求遵守 Windows guidance，原文为：

> Do not act on security or privacy permission requests.

该端没有操作信任或保持受限的选项。
测试窗口已关闭，配置保留，监听与自有进程已结束。
后续需由用户本人处理提示后另行补验。
原始 skill、guidance 完整路径和提示状态保留在 Windows JSON 记录中。
Mac 使用该端允许的保持受限模式完成原生聊天，不将 Mac 结果外推到 Windows。

Harness 桌面原会话完成不同型号 A→B→A。
两次菜单自动更新，发送正常，后两轮保留前文。
停止 Trace 后浏览器凭据保留、受管密钥移除、监听关闭。
另完成 8 轮原生 Deck 界面请求和 4 轮 Claude OAuth 原会话请求。
后者包含 Trace 关闭后清除旧 API、重启和原会话再次请求。
认证完成关闭后重启 6 轮，每轮并发 4 个助手。
真实 Codex 执行凭据命令并完成不经 Trace 的本地订阅请求。

205 项 Rust 单测、格式与严格静态检查通过。
完整后端 104/104 套件成功返回，含 1 项 Windows 平台跳过。
跳过项为 CLI Home 生命周期。
`credential-os-test` 与 `credential-validation-test` 的真实系统凭据库部分未选择启用。
编译、构建回归、公共边界、运行边界和工作流检查通过。
后端临时目录及自有窗口、进程已清理，诊断失败夹具另行保留。
原有聊天和资源管理器窗口保持不变。
EXE 未签名，未推送、安装或发布。

## 合并后的测试脚本

已合入 Windows 客户端入口、原生 UI 测试和 VS Code 测试兼容处理。
Windows 的 Cline、Hermes 后台进程清理仅匹配本轮隔离目录和精确可执行程序。
普通客户端也增加了停止后日记移除、监听关闭与重启选择保留检查。
Mac 保留短临时路径，避免超过 Unix socket 路径限制。
Mac VS Code 仅关闭测试窗口，Windows 退出隔离测试实例。
产品 Rust 与两边固定候选均不因这些测试脚本合并而改写。
