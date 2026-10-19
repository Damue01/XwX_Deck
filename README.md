<p align="center">
  <img src="assets/icon.png" width="80" height="80" alt="XwX Deck 图标">
</p>

<h1 align="center">XwX Deck</h1>
<p align="center"><strong>好工具，更简单</strong></p>
<p align="center">管理 AI 客户端的模型连接，看清每一次请求。</p>

<p align="center">
  <a href="https://xwxdeck.com">官网</a>&nbsp;&nbsp;&nbsp;
  <a href="https://xwxdeck.com/docs/">文档</a>&nbsp;&nbsp;&nbsp;
  <a href="https://xwxdeck.com/?demo=dashboard#experience">在线体验</a>&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/Damue01/XwX_Deck/releases/latest">下载</a>
</p>

[![XwX Deck 仪表盘：请求、Token、费用与耗时](assets/github/trace-preview.png)](https://xwxdeck.com/?demo=dashboard#experience)

<p align="center">
  <a href="https://xwxdeck.com/?demo=dashboard#experience">体验仪表盘</a>&nbsp;&nbsp;&nbsp;
  <a href="https://xwxdeck.com/?demo=models#experience">体验模型管理</a>
</p>

## 一个地方，管理连接与请求

XwX Deck 配合已有 AI 客户端使用。配置模型连接，按需开启 Trace，在本机查看请求的完整过程。

| 能力 | 你可以做什么 |
| --- | --- |
| 模型连接 | 为已接入的 AI 客户端选择服务与模型，保留每个连接的选择。 |
| 请求追踪 | 查看请求、响应、工具调用、Token、参考费用与耗时。 |
| 本地管理 | 管理保存在本机的设置与记录，自行选择存储容量和清理方式。 |

[了解功能与范围](https://xwxdeck.com/docs/about)

## 下载

| 平台 | 安装包 | 安装方式 |
| --- | --- | --- |
| macOS Apple Silicon | [下载 DMG](https://github.com/Damue01/XwX_Deck/releases/latest/download/XwX-Deck-mac-arm64.dmg) | 打开后拖入“应用程序”。 |
| Windows x64 | [下载安装包](https://github.com/Damue01/XwX_Deck/releases/latest/download/XwX-Deck-windows-x64-setup.exe) | 下载后按提示安装。 |

[安装与更新说明](https://xwxdeck.com/docs/download)　[GitHub Releases 与更新记录](https://github.com/Damue01/XwX_Deck/releases)

Windows 按用户 Setup 的构建、数据保留和升级验收见 [Windows 安装说明](docs/windows-setup.md)。

## 三步开始

1. **安装客户端。** 安装 XwX Deck，以及你要使用的 AI 客户端。
2. **添加连接。** 在设置中添加自己的模型服务，或导入已有配置。
3. **选择并使用。** 选择服务与模型，在客户端发起对话；按需开启 Trace，查看仪表盘。

快速开始以 Codex 为例。更多客户端可在“客户端管理”中添加，接入方式以界面提示为准。

新安装的服务列表为空。导入保留来源文件，不会自动切换服务。

[阅读快速开始](https://xwxdeck.com/docs/)

## 文档与帮助

| 配置与使用 | 记录与维护 |
| --- | --- |
| [服务与配置](https://xwxdeck.com/docs/connections) | [Trace 与用量](https://xwxdeck.com/docs/trace-and-usage) |
| [模型与客户端](https://xwxdeck.com/docs/models-and-clients) | [设置与本地数据](https://xwxdeck.com/docs/settings-and-data) |
| [账号与服务切换](https://xwxdeck.com/docs/accounts-and-switching) | [常见问题](https://xwxdeck.com/docs/troubleshooting) |

遇到问题可 [提交 Issue](https://github.com/Damue01/XwX_Deck/issues)。安全漏洞请使用 [私密报告渠道](.github/SECURITY.md)。

## 开发与贡献

后端采用 Rust/Tauri，前端采用 React 和 TypeScript。

- [开发说明](docs/development.md)：环境、运行与验证入口。
- [工程文档](docs/README.md)：架构、产品要求与维护记录。
- [贡献指南](.github/CONTRIBUTING.md)：问题反馈与代码贡献。

## 许可与数据

项目采用 [Apache License 2.0](LICENSE)。第三方组件与资产见 [许可说明](docs/licenses/third-party-notices.md)。

设置、Trace 与日志保存在本机。模型请求发送至所选服务，参考费用需与服务商实际账单分别核对。在线演示使用脱敏请求记录和示例配置。
