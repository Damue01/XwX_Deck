# 官网构建与部署

官网源码用于介绍产品和演示界面。
演示复用公开版前端。
账号、服务和额度使用合成示例。
仪表盘使用 `dashboard-examples.json` 中的真实请求脱敏记录。
记录由隔离的 Rust Gateway 捕获，客户端为采集脚本。
数据来自正式上游响应，保留实际用量、耗时和冻结参考费用。
它们不是 CLI 实测或服务商账单。
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
人工审核的脱敏请求数据随源码维护。
构建不会读取本机日志或账号文件。

## 仪表盘示例

`view.html` 展示纽约天气、时差和步行路线三个真实请求。
`viewer.html` 保留为兼容入口。
页面注明采集日期，天气属于当时的查询结果。
身份、鉴权头、原始会话 ID、本机路径和不透明推理项均已移除。
公开问题、回复、联网查询、Token、耗时和参考费用按采集结果保留。
构建校验数据白名单与用量证据，拒绝私密字段。

## 下载与发布

Windows x64 与 macOS Apple Silicon 默认使用 GitHub 最新 Release 制品链接。
当前版本为 1.1.1，Mac 已签名、公证。
仅填写已发布并核实的制品地址。
网页不宣称尚未发布的版本已经可用。

GitHub Pages 工作流先构建并验证官网。
文档发布在 `/docs/`。
站点绑定 `xwxdeck.com`，Cloudflare 管理 DNS。
下载包继续托管在 GitHub Releases。
下载入口仅在首屏展示，Windows 与 macOS 并排。
页尾提供 GitHub 项目和问题反馈入口。
