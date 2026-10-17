<p align="center">
  <img src="assets/icon.png" width="72" height="72" alt="XwX Deck 图标">
</p>

<h1 align="center">XwX Deck</h1>
<p align="center"><strong>好工具，更简单</strong></p>
<p align="center">管理 Claude 与 Codex 的模型连接，看清每一次请求。</p>

<p align="center">
  <a href="https://xwxdeck.com">官网</a>&nbsp;&nbsp;&nbsp;
  <a href="https://xwxdeck.com/docs/">使用文档</a>&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/Damue01/XwX_Deck/releases/latest">下载</a>&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/Damue01/XwX_Deck/issues">问题反馈</a>
</p>

[![Trace 请求与用量预览](assets/github/trace-preview.png)](https://xwxdeck.com/#experience)

官网演示中的真实请求记录，已脱敏。点击图片体验。

## 下载与安装

[下载 Windows x64 版](https://github.com/Damue01/XwX_Deck/releases/latest/download/XwX-Deck-windows-x64.exe)　
[下载 macOS Apple Silicon 版](https://github.com/Damue01/XwX_Deck/releases/latest/download/XwX-Deck-mac-arm64.dmg)

Windows 下载后即可运行；macOS 打开 DMG，拖入“应用程序”。
当前提供以上两个平台的安装包。
安装与更新步骤见 [下载与安装](https://xwxdeck.com/docs/download)。
所有已发布版本见 [GitHub Releases](https://github.com/Damue01/XwX_Deck/releases)。

## 让连接与请求更清楚

- **选择模型服务。** 为 Claude 和 Codex 分别管理连接与模型，保留每个连接的选择。
- **查看真实请求。** 通过 Trace 核对请求、响应、Token、参考费用和耗时。
- **管理本地数据。** 设置、记录与日志保存在本机，存储容量和清理方式由你决定。

XwX Deck 配合已有 AI 客户端使用。
模型请求发送至当前选择的服务。
参考费用与服务商实际账单分别核对。
支持范围见 [功能与范围](https://xwxdeck.com/docs/about)。

## 开始使用

1. 安装 XwX Deck，以及需要使用的 Claude 或 Codex 客户端。
2. 在设置中添加自己的服务，或导入已有配置。
3. 在模型页选择服务与模型，按需开启 Trace，再到客户端发起对话。

新安装的服务列表为空。
导入会保留来源文件，也不会自动切换服务。
完整操作见 [快速开始](https://xwxdeck.com/docs/)。

## 使用文档

- [服务与配置](https://xwxdeck.com/docs/connections)
- [模型与客户端](https://xwxdeck.com/docs/models-and-clients)
- [账号与服务切换](https://xwxdeck.com/docs/accounts-and-switching)
- [Trace 与用量](https://xwxdeck.com/docs/trace-and-usage)
- [设置与本地数据](https://xwxdeck.com/docs/settings-and-data)
- [常见问题](https://xwxdeck.com/docs/troubleshooting)

<details>
<summary>开发与贡献</summary>

后端使用 Rust/Tauri，前端使用 React 和 TypeScript。
构建环境、验证入口和运行边界见 [开发说明](docs/development.md)。
提交改动前，请阅读 [贡献指南](CONTRIBUTING.md) 和 [开发约定](AGENTS.md)。

</details>

项目采用 [Apache License 2.0](LICENSE)。
安全问题请按 [安全说明](SECURITY.md) 反馈。
