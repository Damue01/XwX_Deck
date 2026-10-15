# 官网构建与部署

官网源码用于介绍产品和演示界面。
演示复用公开版前端。
账号、服务、额度和仪表盘记录均为示例。
界面使用当前公开版前端和 Viewer。
演示不读取本机客户端配置或真实凭据。

## 构建与验证

在仓库根目录执行以下命令。

```sh
npm run build:site
npm run test:site
```

浏览器测试复用已安装的 Playwright。
可通过 `XWX_PLAYWRIGHT_MODULE` 指定该模块。
`XWX_SITE_PREVIEW_DIR` 可指定待验证的预览目录。

生成文件统一放在 `test-results/site-preview`。
该目录不提交到 Git。
源码目录不保存生成的 JavaScript、字体或应用快照。

## 下载与发布

Windows x64 与 macOS Apple Silicon 默认使用 GitHub 最新 Release 制品链接。
当前版本为 1.1.1，Mac 已签名、公证。
仅填写已发布并核实的制品地址。
网页不宣称尚未发布的版本已经可用。

GitHub Pages 工作流先构建并验证官网。
文档发布在 `/docs/`。
站点绑定 `xwxdeck.com`，Cloudflare 管理 DNS。
下载包继续托管在 GitHub Releases。
