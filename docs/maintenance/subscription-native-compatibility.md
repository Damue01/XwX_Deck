# 订阅与原生连接

调研日期：2026 年 10 月 18 日。
本页区分厂商公开能力与 Deck 当前实现。
文档确认不等于真实账号生成验收。

## 判定原则

订阅身份本身不要求 Trace。
直连需要同时满足请求协议、账号认证和续期。
协议一致时，Gateway 可以直接转发原生格式。
认证代管与协议转换是两种不同职责。

例如 Codex 使用 Responses。
ChatGPT 官方登录已经具备原生认证与续期。
同一登录不需要 Deck 再提供本地认证入口。
换用 Deck 管理的另一个账号时，协议仍可原生转发。
Codex 可通过命令获取该账号的令牌。
认证与 Trace 分开处理。

## 公开能力与当前实现

| 来源 | 官方原生能力 | Deck 当前边界 |
| --- | --- | --- |
| ChatGPT 官方登录 | Codex 支持订阅登录并自动续期 | 当前本地登录，以及身份一致的导入登录，可直接使用；保留原凭据 |
| ChatGPT API 授权 | 官方提供 Responses 和 Codex 命令认证；应用负责令牌续期 | Codex 原生 Responses 使用认证命令直连；Deck 或导入来源保留续期职责 |
| Claude 订阅 | Claude Code 支持 claude.ai 登录；独立配置目录可分开账号 | 客户端原有登录保持直连；Deck 添加的账号位于独立登录目录，尚未实现客户端直接选用该目录 |
| GitHub Copilot | 官方 CLI/SDK 支持 GitHub 登录和令牌提供器 | Codex 在模型支持 Responses 时使用认证命令；地址和请求头必须与绑定一致 |
| Grok Build | 官方客户端支持浏览器登录；公开 API 支持 Responses 与 API Key | 保留专用客户端续期；Codex 原生 Responses 可用认证命令，真实订阅权限另验 |
| Cursor | 公开 API/SDK 支持 Agent 工作流，文档明确不是独立模型推理 API | 当前适配客户端专用协议，不能仅凭模型名称认定为 Responses 直连 |

Claude 的 `CLAUDE_CODE_OAUTH_TOKEN` 可以提供访问令牌。
官方说明该方式整场会话沿用同一令牌。
过期后需要替换令牌并重启。
因此，把短期令牌写进设置不能代替完整的账号接入。

Claude 的 `apiKeyHelper` 面向 API Key。
官方说明它会同时发送两种认证头。
不能把它直接当作订阅 OAuth 的续期接口。
当前保留原生登录直连。
Deck 管理的其他 Claude 账号仍经 Gateway。

## Codex 认证命令

Codex 配置只保存命令和非秘密绑定。
访问令牌通过标准输出返回，不写入客户端配置。
命令每 30 秒按需重新读取账号状态。
账号原有模块负责刷新和原子保存。
导入账号只读取来源的最新令牌。
来源未续期时，提示回到来源客户端处理。
该入口不监听模型请求，也不启动 Trace。

Deck 运行时使用本地认证通道。
Windows 使用命名管道，macOS 使用私有套接字。
并发命令共享账号锁，避免重复轮换。
Deck 关闭后，命令获取同一个目录锁。
它只打开账号存储，不恢复路由或读取对话。
启动 Deck 时会等待正在完成的单次续期。

绑定包含连接 ID、账号 ID、地址和请求头。
选择 B 账号后，旧客户端仍只能取 A 的令牌。
重新加载客户端后才使用 B。
退出 A 后，旧命令明确失败，不代换账号。
续期若改变地址或身份，要求重新选择服务。
直接连接沿用明确选择，不执行 Gateway 的账号故障转移。

验证使用隔离账号和本地服务。
已安装的 Windows Codex 完成了命令认证与 Responses 请求。
真实厂商权限和 macOS 运行仍需分别验收。

## 简单的连接策略

1. 先确认客户端是否能原生使用所选登录。
2. 可原生使用时直连，不按订阅分类强制开启 Trace。
3. 原生 Responses 的 Codex 连接优先使用认证命令。
   不支持该认证接口的客户端继续使用 Gateway。
4. 客户端和上游协议不同，才执行协议转换。
5. 新模型沿用服务声明和已有协议匹配规则；用户明确选择优先。

`/models` 能返回模型目录或协议声明。
它不能单独证明登录兼容、续期能力与账号权限。
不从模型名称推断订阅授权的可移植性。

## 依据

- [OpenAI：认证与登录缓存](https://learn.chatgpt.com/docs/auth)：订阅登录和自动续期。
- [OpenAI：Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)：Responses 接入和应用负责续期。
- [OpenAI：配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)：自定义服务和命令提供令牌。
- [OpenAI：高级配置](https://learn.chatgpt.com/docs/config-file/config-advanced)：认证命令、刷新间隔和互斥字段。
- [OpenAI：API 授权限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)：API 授权的请求字段限制。
- [Claude：认证](https://code.claude.com/docs/en/authentication)：订阅登录和独立配置目录。
- [Claude：环境变量](https://code.claude.com/docs/en/env-vars)：访问令牌的会话与过期行为。
- [Claude：Gateway 认证](https://code.claude.com/docs/en/llm-gateway-connect)：认证头和辅助命令的行为。
- [GitHub：Copilot SDK 认证](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)：原生登录和会话令牌续期。
- [Grok Build：开始使用](https://docs.x.ai/build/overview)：浏览器登录和公开 API 示例。
- [Cursor：API 概览](https://cursor.com/docs/api)：Agent API 与独立模型推理 API 的边界。

## Key 遮罩尺寸

密码遮罩没有统一规定的圆点直径。
[MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/password)
说明遮罩字符由浏览器和操作系统决定。
[Fluent 输入框](https://fluent2.microsoft.design/components/web/react/core/input/usage)
提供整体输入交互参考。

Deck 保持 13 px 字号和等宽字距。
圆点直径从 0.5 em 调至 0.3 em，约为 3.9 px。
这是应用的视觉选择，不是标准要求的固定值。
显示与隐藏时，一个字符占用相同宽度。
