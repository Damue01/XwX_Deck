# 客户端管理范围

## 判断依据

2026-10-18 对照 CC Switch、Magpie 的说明和实现。
客户端目录只列有配置适配或明确接入方式的产品。
安装检测、纳入管理、配置保存和实际请求分别验收。
下载链接和服务商登录不代表能管理该客户端。
编辑器插件按实际能力判断，不因产品形态排除。
下载目录可以展示未适配的产品，模型页只展示可管理项。

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
| 已有配置适配 | ChatGPT / Codex、Claude、OpenCode、Gemini CLI、Qwen Code、Pi、MiMo Code、Crush、Droid、CodeBuddy Code、WorkBuddy、DeepSeek Harness、Cline、VS Code Chat、Kimi Code、Grok Build | 保存模型选择，按各客户端现有适配处理连接和恢复 |
| 明确的手动接入 | GitHub Copilot CLI、oh-my-pi、Hermes Agent、Qoder、Zed、Goose | 保存 Deck 路由，提供连接信息；用户在客户端完成连接 |

共 22 个产品，其中 16 个有配置适配，6 个需手动接入。
本轮新增适配的 Windows 成品包验收见整合验收。
Desktop 与 CLI 仅在消费相同配置时归并。
VS Code Chat 需识别到支持 Custom Endpoint 的正式版本。
Cline 支持当前 CLI 与扩展 4.x 的配置格式。
较旧或未知的扩展格式保留下载入口。
扩展在启动时读取配置，已有进程需要重新加载。
DeepSeek Harness 按当前 profile 格式处理桌面版与 CLI。
旧版单文件格式不自动改写，提示更新客户端。
手动接入不宣称已经改好客户端配置。
Qoder 的字段和权限以当前账号的自定义模型向导为准。
[Copilot CLI 官方说明](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)明确支持自定义模型地址。
这不代表所有编辑器中的 Copilot 都采用同一配置方式。

## 后续适配方案

以下记录参考实现与能力边界。
只有上表所列适配开放模型管理，其余保留下载入口。
Magpie 源码核对至 `d783df46cbac9021e26a6bd71ca0b55544552eb2`。
插件、CLI 和桌面版分别检查，不能互相代验。

| 项目 | 已核对的参考与 Deck 方案 |
| --- | --- |
| Cline 扩展与 CLI | 配置服务、模型和恢复，并同时处理扩展 Plan 与 Act 状态。桌面版的选择由其界面保存，不能套用扩展结论 |
| VS Code Chat | 配置 Custom Endpoint 模型目录和新对话默认模型，保留多 profile 的继承选择。当前会话选择不能冒充默认模型已切换 |
| Cursor CLI | Magpie 可写 CLI 自身的模型选择。这不证明支持任意 Deck 服务；实际接入能力另验 |
| Cursor Private Inference | Magpie 有独立适配，通过专用环境变量接入模型端点。必须按产品身份单独检测，不能归并为普通 Cursor 桌面版 |
| Cursor 普通桌面版 | 本次核对的适配未证明可由外部可靠切换其服务与模型。保留下载入口，暂不添加模型页 |
| TRAE 桌面版 | 本次在 CC Switch 功能表和 Magpie 内置适配中未找到对应模型配置切换。账号导入或服务代理不等于管理 TRAE 客户端；保留下载入口，暂不添加模型页 |
| DeepSeek Harness | Windows 读取安装登记，支持自定义安装目录。合并各 profile 的模型服务与默认模型，保留原插件配置。桌面凭据按当前版本的本地存储读取方式写入 |
| Antigravity、OpenChamber、T3 Code、ZCode、MiniMax Agent 等 | 按具体适配继续判断。已有参考实现需核对消费方式，不能以通用地址或下载入口代替实际配置能力 |

[Cline 实现](https://github.com/yetone/magpie/blob/d783df46cbac9021e26a6bd71ca0b55544552eb2/internal/agent/cline.go)分别处理扩展状态与 CLI 配置。
[VS Code 实现](https://github.com/yetone/magpie/blob/d783df46cbac9021e26a6bd71ca0b55544552eb2/internal/agent/vscode.go)包含默认模型和 profile 处理。
[VS Code 官方说明](https://code.visualstudio.com/docs/agent-customization/language-models)说明 Custom Endpoint 的模型配置方式。
[Cursor CLI 实现](https://github.com/yetone/magpie/blob/d783df46cbac9021e26a6bd71ca0b55544552eb2/internal/agent/agents.go)只代表对应 CLI。
[Cursor Private Inference 实现](https://github.com/yetone/magpie/blob/d783df46cbac9021e26a6bd71ca0b55544552eb2/internal/agent/cursorlocal.go)按专用构建识别。
[DeepSeek Harness 实现](https://github.com/yetone/magpie/blob/d783df46cbac9021e26a6bd71ca0b55544552eb2/internal/agent/dsh.go)包含新版 profile 和桌面凭据读取差异。
[T3 Code 适配](https://github.com/yetone/magpie/blob/main/internal/agent/t3code.go)也不是一个通用下载入口。
实际管理能力通过验收后，再开放模型页入口。

## 状态与接口

保存的 `modelClients` 是管理列表的唯一来源。
卡片颜色、导入状态和模型页共同读取该列表。
安装扫描保持只读，只决定是否可以添加。
扫描失败不添加客户端，也不撤销已有选择。
Windows 扫描读取当前用户和系统的卸载登记、App Paths、Store 注册信息。
同时检查 PATH、包管理器与常见安装目录。
所有来源均验证实际启动文件，涉及版本能力时再检查产品身份与版本。
可管理客户端提供“选择安装位置”。
手动选择仅检查安装，确认添加时才保存。
已有条目可保存新的安装位置，不重复加入模型页。
检测、导入和账号程序发现共用保存的位置。
选定位置失效后不自动换用其他安装。
Windows 便携版 VS Code 使用所选安装中的 `data/user-data/User`。
普通安装继续使用用户配置目录。
未实现的客户端可以保留下载入口，不能通过添加或导入进入模型页。
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
