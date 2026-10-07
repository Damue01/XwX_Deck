# XwX Deck 开发约定

修改前阅读 [产品范围](PRODUCT.md)、[公开版边界](docs/public-release-boundary.md) 和 [交互与设计约定](docs/ux-product-requirements.md)。

- 按能力吸收修复，保留独立历史、应用身份与发布渠道。新安装没有 API 连接。
- 不引入配置同步、Excel 转换、内部品牌、默认连接或内部 Provider 别名。
- 用户最后一次明确选择必须保留；配置写入不依赖远端目录健康。外部配置变化必须保留并提示。
- Trace 新配置默认上限 1 GB 并开启超出上限自动清理；已有明确容量与清理选择必须保留。手动删除与索引修复仅由用户发起。对话诊断只读 SQLite 元数据和 JSONL 第一条 session_meta，不读取对话正文。
- 验证使用隔离的配置目录和本地测试服务。界面变更需要真实渲染与交互检查；模型/Gateway 变更需要实际请求回归。
- 常规检查：`npm run compile`、`npm run test:built`、`npm run test:upstream`、`npm run check:public-boundary`、`npm run check:workflows`。发布或安装遵循用户当次明确范围。
