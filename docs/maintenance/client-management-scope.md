# 客户端管理范围

## 判断依据

2026-10-18 对照 CC Switch、Magpie 的说明和实现。
客户端目录只列有配置适配或明确接入方式的产品。
安装检测、纳入管理、配置保存和实际请求分别验收。
下载链接和服务商登录不代表能管理该客户端。

[CC Switch 功能表](https://github.com/farion1231/cc-switch#supported-features-by-tool)分别列出配置管理与本地路由。
Claude Code、Codex、Gemini CLI 和 Grok Build 支持本地路由。
OpenCode、OpenClaw、Hermes 的配置管理不等于该项目提供本地代理。
这些结果用于判断接入方式，不代替 Deck 的回归。

[Magpie 客户端参考](https://github.com/yetone/magpie/blob/main/docs/reference.md)记录了各产品的配置文件和管理字段。
[客户端适配清单](https://github.com/yetone/magpie/blob/main/internal/agent/agents.go)区分实际适配与仅识别请求来源。
Deck 同样按具体消费端判断，不能只认一个安装文件。

## 当前范围

| 方式 | 客户端 | Deck 行为 |
| --- | --- | --- |
| 已有配置适配 | ChatGPT / Codex、Claude、OpenCode、Gemini CLI、Qwen Code、Pi、MiMo Code、Crush、Droid、CodeBuddy Code、WorkBuddy | 保存模型选择，按各客户端现有适配处理连接和恢复 |
| 明确的手动接入 | GitHub Copilot CLI、oh-my-pi、Hermes Agent、Qoder、Zed、Goose | 保存 Deck 路由，提供连接信息；用户在客户端完成连接 |

共 17 个产品，Desktop 与 CLI 别名按现有产品身份归并。
手动接入不宣称已经改好客户端配置。
Qoder 的字段和权限以当前账号的自定义模型向导为准。
[Copilot CLI 官方说明](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)明确支持自定义模型地址。
这不代表所有编辑器中的 Copilot 都采用同一配置方式。

## 暂不纳入

| 项目 | 原因 |
| --- | --- |
| VS Code 本体 | Magpie 有专门的 Chat 适配，涉及版本、配置文件和多 profile。Deck 尚无对应实现，本轮不增加 |
| Cline 等编辑器插件 | 按本轮范围不管理插件；发现编辑器不代表已安装插件或可以接管 |
| TRAE、Cursor | Deck 当前没有可提供实际模型配置的消费端适配，不能以安装状态显示为已管理 |
| Antigravity、OpenChamber、T3 Code | 有下载或其他项目参考，但 Deck 的连接方式尚未验证。本轮不以通用 Gateway 地址代替专门适配 |
| Kimi Code、ZCode、DeepSeek Harness、MiniMax Agent 等 | 保留产品资料和导入来源，完成对应适配及请求回归后再加入管理目录 |

[Magpie 的 VS Code 实现](https://github.com/yetone/magpie/blob/main/internal/agent/vscode.go)包含版本与 profile 处理。
[T3 Code 适配](https://github.com/yetone/magpie/blob/main/internal/agent/t3code.go)也不是一个通用下载入口。
本轮收敛目录，不照搬其他项目的完整客户端数量。

## 状态与接口

保存的 `modelClients` 是管理列表的唯一来源。
卡片颜色、导入状态和模型页共同读取该列表。
安装扫描保持只读，只决定是否可以添加。
扫描失败不添加客户端，也不撤销已有选择。
未实现的客户端不会进入新添加或导入列表。
历史明确保存的条目保留，可在管理窗口移除。
移除不卸载客户端，不删除其模型配置。

共享能力规则生成 Rust 使用的客户端目录。
原生桥接必须提供客户端路由读取和保存接口。
缺少接口时明确报错，不能退回下载链接冒充模型面板。
Windows 官方账号接口复用客户端发现模块。
优先使用已注册桌面版附带的原生账号程序。
不把桌面 GUI 程序当成账号命令，不要求重复安装 CLI。

## 验收要求

检查新安装、已安装未管理、已管理和移除后的状态。
检查重新检测、重新打开窗口和进程重启。
检查不支持条目的添加与导入均不写入配置。
在成品包中选择非 Codex 客户端的服务和模型。
读取实际保存结果，再通过本地服务完成请求。
桌面版账号接口使用隔离配置启动检查。
真实服务权限与额度另行记录，不由本地服务代验。
