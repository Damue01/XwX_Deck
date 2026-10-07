# XwX Deck

XwX Deck 是一个独立的本地 Claude / ChatGPT 请求追踪与模型网关管理客户端。

项目使用 [Apache License 2.0](LICENSE) 开源。

本仓库按能力吸收上游修复，维护独立 Git 历史、应用身份和发布渠道。具体范围见 [技术吸收记录](docs/upstream-port.md)。当前独立版包含：

- Trace 请求追踪与本地仪表盘；
- Claude / ChatGPT 客户端接入；
- 模型服务配置、模型选择与协议适配；
- 本地 Gateway、会话归并与上下文续接；
- ChatGPT 对话诊断，可检查索引与 Session 元数据；
- 用量与分档/时段计费估算、模型能力注册表；
- 经当前 Gateway 实测的推理能力层与模型档位诊断工具；
- 当前问题与最近失败诊断、手动 Trace 索引修复、安全重置和退出恢复；
- 外观、数据目录、开机启动等基础设置。

独立版不包含：

- 客户端配置同步；
- Excel / CSV 转 Markdown。

## 下载与开始使用

从 [GitHub Releases](https://github.com/Damue01/XwX_Deck/releases) 下载对应系统的安装包，并核对 SHA-256。macOS Apple Silicon 使用 arm64 DMG，Windows 使用 EXE。完整说明见 [下载与安装](docs/download.md) 和 [快速开始](docs/getting-started.md)。

新安装没有 API 连接。进入「设置 → 模型配置」，可以查看 ChatGPT / Claude 的下载入口，或选择七个官方模型服务预设。服务预设栏支持左右滚动；右上角固定的「自定义」按钮可直接添加其他连接。预设只填入名称、API 地址与接口类型，密钥需要自己填写，保存前不会创建连接。

在模型页为 ChatGPT 和 Claude 分别选择服务和模型。每个连接独立记住选择，目录离线不会撤销已保存的配置。需要协议转换的模型会显示「需 Trace」；运行中的客户端可能缓存旧连接，切换后未生效时需完整退出并重新打开客户端。

Trace 默认无限保留；可在设置中指定存储上限，并主动开启超出上限自动清理。手动删除和索引修复由用户发起。Trace 可能包含提示词、工具结果和响应正文，共享前请检查内容；只读对话诊断只检查索引与 Session 元数据。

## 开发与预览

需要 Node.js 22.12+ 与 npm 11：

```bash
npm ci
npm run compile
npm test
npm run docs:build
npm run preview:web
```

Electron 开发模式：

```bash
npm run dev
```

`preview:web` 提供带演示数据的设置界面预览；它不能证明真实客户端路由或 API 凭据有效。Electron 和 Gateway 回归使用隔离的配置目录与本地测试服务。

提交前的常规检查：

```bash
npm run compile
npm run test:built
npm run test:upstream
npm run check:public-boundary
npm run check:workflows
npm run docs:build
```

本次模型服务入口、切换路由、官方登录和 Trace 设置的实现与测试入口见 [本次改动源码导读](docs/provider-setup-and-routing.md)。维护约定见 [AGENTS.md](AGENTS.md)、[产品范围](PRODUCT.md) 和 [交互与设计约定](docs/ux-product-requirements.md)。

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

打包后验证真实安装包中的界面、Trace 请求和后台 Gateway：

```bash
npm run test:packaged
npm run test:packaged-gateway
```

可用 `XWX_DECK_RELEASE_DIR` 指向另外的制品目录。上述命令使用隔离数据，不替换已安装应用。

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

可添加多个服务连接，并为 Claude 与 ChatGPT 分别选择。新安装不预置 API 服务商。连接配置包括：

- 名称；
- URL；
- Key；
- 接口（自动识别、Responses、Chat Completions 或 Anthropic Messages）；
- 可选模型 ID，用于没有模型目录的服务。

服务端声明的逐模型协议优先；缺失声明时参考明确指定的接口、目录端点证据和已核验的能力元数据，未知情况保留连接默认值。不会仅凭服务名称猜测协议。明确指定接口时保留 API 路径前缀。每个连接分别保存模型和上下文窗口，官方模型目录读取本地客户端缓存。

模型目录返回 404/405 时保持为空，可手工填写实际模型或 Endpoint ID；不会生成虚假的单模型目录。兼容边界见 [服务商兼容说明](docs/provider-compatibility.md)。

更多说明见 [docs/README.md](docs/README.md)。
