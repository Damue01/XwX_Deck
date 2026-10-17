# 开发说明

本文面向源码维护者，不发布到官网使用手册。
产品要求见 [产品范围](product.md) 和 [交互与设计约定](ux-product-requirements.md)。

## 环境与运行

需要 Node.js 22.12 及以上版本、npm 11 和 Rust stable。
macOS 需要 Command Line Tools。
Windows 需要 MSVC 与 WebView2。

```sh
npm ci
npm run compile
npm run dev
```

开发模式使用隔离配置。
应用只维护 Rust/Tauri 后端，Node.js 用于开发、构建和测试。
详细说明见 [原生运行时](../tools/native/README.md)。

## 验证与预览

```sh
npm run check:quality
npm run check:test-plan
npm run check:workflows
npm run build:site
DOCS_BASE=/docs/ npm run docs:build
```

官网演示用于检查布局与交互。
真实配置、授权与请求需要单独验证。
文档组装与浏览器检查见 [官网构建说明](../web/site/README.md)。
完整验收规则见 [开发与测试流程](development-testing-workflow.md)。

## 构建与发布

```sh
npm run build:mac:arm64
npm run build:win
```

Windows 制品在原生 Windows x64 主机验证。
macOS 使用 `npm run build:native:mac:signed` 构建签名候选。
签名、公证、安装和实际更新分别记录。
构建不会自动发布版本。

`main` 推送触发工程检查和官网部署。
版本标签触发原生构建，并创建草稿 Release。
核对制品后，再按 [发布说明](github-release.md) 公开发布。

## 独立运行边界

- 当前源码版本：`1.0.0`。
- 应用 ID：`app.xwxdeck.desktop`。
- 数据目录命名空间：`xwx-deck`。
- Gateway 固定地址：`127.0.0.1:45233`；隔离验收使用临时端口。
- 更新渠道：独立 GitHub Releases。

本项目不提供客户端配置同步、ChatGPT 对话诊断或 Excel 转换。
应用身份与数据目录保持稳定。
维护范围见 [仓库边界](repository-boundary.md)。
