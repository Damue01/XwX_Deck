# Contributing to XwX Deck

感谢你帮助改进 XwX Deck。

## 开始之前

1. 先搜索现有 Issue 和 Pull Request，避免重复工作。
2. Bug 请提供操作系统、架构、XwX Deck 版本、客户端版本和可复现步骤。
3. 不要提交 API Key、Cookie、完整 Trace、公司域名或其他敏感信息。
4. 大功能先开 Discussion 或 Issue，确认产品边界后再实现。

## 本地开发

```bash
npm ci
npm run compile
npm run test:built
npm run docs:build
npm run check:public-boundary
```

Renderer 改动还应执行：

```bash
npm run preview
```

并实际检查页面、交互和浏览器控制台。

## Pull Request

- 一次 PR 聚焦一个问题。
- 说明用户可见变化、兼容性影响和验证证据。
- 更新对应文档和测试。
- 不要把生成的 `dist/`、`release/` 或本地密钥提交进仓库。

提交 Contribution 即表示你同意该贡献按 Apache License 2.0 授权。
