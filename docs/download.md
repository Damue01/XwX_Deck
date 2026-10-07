# 下载与安装

## XwX Deck

[下载 XwX Deck](https://github.com/Damue01/XwX_Deck/releases)

在 Releases 中选择与你的系统对应的安装包：Windows 下载 EXE，Apple Silicon Mac 下载 arm64 DMG。下载后核对该版本提供的 SHA-256。

macOS 安装时，将应用拖入“应用程序”。当前 macOS 测试包尚未经过 Developer ID 签名与 Apple 公证；首次打开遇到系统提示，请参照 [macOS 首次运行](./macos-first-run.md)。

## ChatGPT 客户端

在 XwX Deck 的「设置 → 模型配置 → 客户端」点击 ChatGPT，可通过顶部的「官方下载」获取当前系统的官方版本；展开「Windows 镜像」或「Mac 镜像」，点击架构名称即可直接下载镜像安装包。Linux 和其他版本可通过本页下方的官方指南与列表获取。也可以直接选择下表中的链接：

| 系统 | 官方下载 | 国内镜像（第三方） |
| --- | --- | --- |
| Mac Apple Silicon | [下载安装包](https://persistent.oaistatic.com/codex-app-prod/Codex.dmg) | [下载安装包](https://codexapp.agentsmirror.com/latest/mac-arm64) |
| Mac Intel | [下载安装包](https://persistent.oaistatic.com/codex-app-prod/ChatGPT-26.1002.52244-x64.dmg) | [下载安装包](https://codexapp.agentsmirror.com/latest/mac-intel) |
| Windows x64 | [Microsoft Store 安装页](https://apps.microsoft.com/detail/9PLM9XGG6VKS) | [下载安装包](https://codexapp.agentsmirror.com/latest/win-x64) |
| Windows ARM64 | [Microsoft Store 安装页](https://apps.microsoft.com/detail/9PLM9XGG6VKS) | [下载安装包](https://codexapp.agentsmirror.com/latest/win-arm64) |
| Linux | [官方安装指南](https://learn.chatgpt.com/docs/linux/linux-app) | 暂无稳定版直连镜像 |

镜像链接直接下载安装包，不经过 GitHub 或推广页面。[镜像校验和](https://codexapp.agentsmirror.com/latest/checksums)可用于核对下载文件。Intel 官方链接对应 2026-10-07 核对的版本，镜像短链始终指向镜像当前稳定版。

[官方下载列表](https://learn.chatgpt.com/docs/app) · [国内镜像列表](https://codexapp.agentsmirror.com/#mirror)。镜像列表可选择不同系统；历史版本与 Linux 预览版当前仍通过镜像仓库的 GitHub Releases 提供。

已经安装的用户可以跳过。首次使用按客户端提示完成登录；使用 Codex 时，在客户端选择 Codex 并打开一个项目文件夹。入口和可用功能以当前客户端版本为准，参照 [官方起步指南](https://learn.chatgpt.com/docs/quickstart)。

## Claude 客户端

在 XwX Deck 的「设置 → 模型配置 → 客户端」点击 Claude，可通过顶部的「官方下载」获取当前系统的官方版本；展开「Windows 镜像」或「Mac 镜像」，点击架构名称即可直接下载镜像安装包：

| 系统 | 官方下载 | 国内镜像（第三方） |
| --- | --- | --- |
| Mac（通用，Apple Silicon + Intel） | [Claude 官方下载](https://claude.com/download) | [下载安装包](https://claudeapp.agentsmirror.com/latest/mac) |
| Windows x64 | [Claude 官方下载](https://claude.com/download) | [下载安装包](https://claudeapp.agentsmirror.com/latest/win-x64) |
| Windows ARM64 | [Claude 官方下载](https://claude.com/download) | [下载安装包](https://claudeapp.agentsmirror.com/latest/win-arm64) |
| Linux x64 / arm64 | [Claude Desktop on Linux](https://code.claude.com/docs/en/desktop-linux) | 暂未接入客户端入口 |

镜像来自 [Wangnov/claude-app-mirror](https://github.com/Wangnov/claude-app-mirror)，仅镜像官方安装包，不构建、不修改、不重打包；[校验和](https://claudeapp.agentsmirror.com/latest/checksums)与历史版本见其 GitHub Releases。

## DeepSeek API

[打开 DeepSeek 密钥管理](https://platform.deepseek.com/api_keys)

登录后创建 API Key，复制并保管好密钥。API 按服务商规则计费，请在后台确认余额与价格；DeepSeek 网页聊天与 API 用量分别管理。

准备好密钥后，按 [快速开始](./getting-started.md) 在 XwX Deck 中完成配置。密钥只填入客户端，不要提交到官网、截图或公开讨论中。

## 其他官方模型服务

「设置 → 模型配置 → 模型服务」横向提供 DeepSeek、千问、火山方舟、智谱 GLM、Kimi、MiniMax 和腾讯 TokenHub，可通过触控板横向滑动、悬停时普通鼠标滚轮或 Tab 键聚焦浏览，不显示滚动条或左右箭头。其他服务使用右上角固定的「自定义」入口。卡片确认后预填名称、API 地址与接口类型，不创建连接，也不替代 API 密钥。

| 服务 | 官方密钥管理 | API 地址 | 接口 |
| --- | --- | --- | --- |
| 千问（阿里云百炼） | [获取密钥](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Responses |
| 火山方舟 | [获取密钥](https://ark.volcengine.com/region:cn-beijing/apikey) | `https://ark.cn-beijing.volces.com/api/v3` | Responses |
| 智谱 GLM | [获取密钥](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) | `https://open.bigmodel.cn/api/paas/v4` | Chat Completions |
| Kimi | [获取密钥](https://platform.kimi.com/console/api-keys) | `https://api.moonshot.cn/v1` | Chat Completions |
| MiniMax | [获取密钥](https://platform.minimax.cn/user-center/basic-information/interface-key) | `https://api.minimax.cn/v1` | Chat Completions |
| 腾讯 TokenHub | [获取密钥](https://console.cloud.tencent.com/tokenhub/apikey?regionId=1) | `https://tokenhub.tencentmaas.com/v1` | Chat Completions |

这些预设针对国内普通 API 账户，Coding Plan／订阅套餐可能使用专属地址和密钥，应按对应官方文档修改。阿里云预设使用北京地域的共享兼容地址，其他地域或工作空间请按[官方 Base URL 文档](https://help.aliyun.com/zh/model-studio/base-url)填写；火山方舟的模型需按账户开通情况选择，必要时填写 Endpoint ID；腾讯预设使用广州地域的密钥与地址。模型可用性和实际调用费用以服务商后台为准。
