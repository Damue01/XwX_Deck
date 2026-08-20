# XwX Deck

XwX Deck 是一个独立的本地 Claude / ChatGPT 请求追踪与模型网关管理客户端。

项目使用 [Apache License 2.0](LICENSE) 开源。

这个仓库从 XwX Deck `main` 的提交 `65a02a3ae4f2ec1276889d066da0cba75025e215` 净化导出，使用新的 Git 根历史，并与内部版本隔离。当前独立版只保留：

- Trace 请求追踪与本地仪表盘；
- Claude / ChatGPT 客户端接入；
- 模型服务配置、模型选择与协议适配；
- 本地 Gateway、会话归并与上下文续接；
- 用量与分档/时段计费估算、模型能力注册表；
- 经当前 Gateway 实测的推理能力层与模型档位诊断工具；
- 应用快速修复、安全重置和退出恢复；
- 外观、数据目录、开机启动等基础设置。

独立版不包含：

- 客户端配置同步；
- 工具页面；
- Excel / CSV 转 Markdown。

## 开发

需要 Node.js 22.12+ 与 npm 11：

```bash
npm ci
npm run compile
npm test
npm run docs:build
npm run preview
```

Electron 开发模式：

```bash
npm run dev
```

## 独立运行边界

- 应用 ID：`app.xwxdeck.desktop`
- 数据目录命名空间：`xwx-deck`
- Gateway 默认端口段：`45233-45242`
- 版本线：从 `0.1.0` 开始
- 自动更新：默认读取 GitHub Releases；可用 `XWX_DECK_UPDATE_SERVER_URL` 覆盖

这些设置用于避免与内部 XwX Deck 安装共享配置、Trace 数据、单实例身份和 Gateway 端口。

## 构建

```bash
npm run build:mac:arm64
npm run build:win
```

Windows 制品必须在原生 Windows x64 主机验证；macOS 制品的签名、公证状态应按实际构建环境单独说明。

## GitHub

- Pull Request 和 `main` 推送运行 CI、测试、文档构建和公共边界检查。
- `main` 文档通过 GitHub Pages 发布。
- `v*.*.*` 标签触发 Windows x64 和 macOS arm64 原生构建。
- Release workflow 只创建 **Draft Release**；人工核对制品后再发布。
- GitHub Release 同时提供更新清单、SHA-256 和构建来源证明。

## macOS 未签名包

当前没有 Apple Developer ID。macOS 构建不应描述为已签名或已公证正式包。

用户确认安装包来自本仓库并核对 SHA-256 后，可以按 [macOS 首次运行说明](docs/macos-first-run.md) 手动处理下载隔离属性。

## 服务商兼容

服务商配置只要求：

- 名称；
- URL；
- Key。

保存后会自动探测可用模型目录，根据每个模型返回的能力元数据选择 Responses、Chat Completions 或 Anthropic Messages。服务商名称会同步显示在模型配置页。

如果上游完全不提供模型目录，才会退回到手动输入模型或 Endpoint ID。兼容边界见 [服务商兼容说明](docs/provider-compatibility.md)。

更多说明见 [docs/README.md](docs/README.md)。
