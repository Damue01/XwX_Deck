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
但当前实现由 Gateway 提供该账号的认证。

## 公开能力与当前实现

| 来源 | 官方原生能力 | Deck 当前边界 |
| --- | --- | --- |
| ChatGPT 官方登录 | Codex 支持订阅登录并自动续期 | 当前本地登录，以及身份一致的导入登录，可直接使用；保留原凭据 |
| ChatGPT API 授权 | 官方提供 Responses 和 Codex app-server 接入；应用负责令牌续期 | 当前由 Deck 或导入来源管理授权，Gateway 提供认证；Responses 无需跨协议转换 |
| Claude 订阅 | Claude Code 支持 claude.ai 登录；独立配置目录可分开账号 | 客户端原有登录保持直连；Deck 添加的账号位于独立登录目录，尚未实现客户端直接选用该目录 |
| GitHub Copilot | 官方 CLI/SDK 支持 GitHub 登录和令牌提供器 | Codex/Claude 未接入 Copilot 原生登录与续期；当前由 Gateway 获取推理凭据，按模型声明选择协议 |
| Grok Build | 官方客户端支持浏览器登录；公开 API 支持 Responses 与 API Key | Deck 的订阅登录使用专用客户端认证；不能把公开 API Key 接入能力当作订阅令牌兼容证据 |
| Cursor | 公开 API/SDK 支持 Agent 工作流，文档明确不是独立模型推理 API | 当前适配客户端专用协议，不能仅凭模型名称认定为 Responses 直连 |

Claude 的 `CLAUDE_CODE_OAUTH_TOKEN` 可以提供访问令牌。
官方说明该方式整场会话沿用同一令牌。
过期后需要替换令牌并重启。
因此，把短期令牌写进设置不能代替完整的账号接入。

Codex 也支持命令提供 Bearer 令牌。
这说明未来可以设计无需常驻 Gateway 的认证方式。
但仍需实现续期、动态地址和请求头，并逐客户端验收。
本次不添加这条尚未验证的路径。

## 简单的连接策略

1. 先确认客户端是否能原生使用所选登录。
2. 可原生使用时直连，不按订阅分类强制开启 Trace。
3. 需要 Deck 提供认证时，经 Gateway 发送原生协议。
4. 客户端和上游协议不同，才执行协议转换。
5. 新模型沿用服务声明和已有协议匹配规则；用户明确选择优先。

`/models` 能返回模型目录或协议声明。
它不能单独证明登录兼容、续期能力与账号权限。
不从模型名称推断订阅授权的可移植性。

## 依据

- [OpenAI：认证与登录缓存](https://learn.chatgpt.com/docs/auth)：订阅登录和自动续期。
- [OpenAI：Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)：Responses 接入和应用负责续期。
- [OpenAI：配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)：自定义服务和命令提供令牌。
- [OpenAI：API 授权限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)：API 授权的请求字段限制。
- [Claude：认证](https://code.claude.com/docs/en/authentication)：订阅登录和独立配置目录。
- [Claude：环境变量](https://code.claude.com/docs/en/env-vars)：访问令牌的会话与过期行为。
- [GitHub：Copilot SDK 认证](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate)：原生登录和会话令牌续期。
- [Grok Build：开始使用](https://docs.x.ai/build/overview)：浏览器登录和公开 API 示例。
- [Cursor：API 概览](https://cursor.com/docs/api)：Agent API 与独立模型推理 API 的边界。

Key 遮罩字形由项目独立绘制。
其生成器为 `tools/build/generate-secret-mask.py`。
该脚本是手动资产工具，依赖开发环境中的 fonttools 与 brotli。
正常编译使用已保存的 WOFF2，不安装 Python 依赖。
