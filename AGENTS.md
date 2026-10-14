# XwX Deck 开发约定

修改前阅读 [产品范围](PRODUCT.md)、[公开版边界](docs/public-release-boundary.md) 和 [交互与设计约定](docs/ux-product-requirements.md)。

- 按能力吸收修复，保留独立历史、应用身份与发布渠道。新安装没有 API 连接。
- 不引入配置同步、Excel 转换、内部品牌、默认连接或内部 Provider 别名。
- 用户最后一次明确选择必须保留；配置写入不依赖远端目录健康。外部配置变化必须保留并提示。
- Trace 新配置默认上限 1 GB 并开启超出上限自动清理；已有明确容量与清理选择必须保留。手动删除与索引修复仅由用户发起。对话诊断只读 SQLite 元数据和 JSONL 第一条 session_meta，不读取对话正文。
- 验证使用隔离的配置目录和本地测试服务。界面变更需要真实渲染与交互检查；模型/Gateway 变更需要实际请求回归。
- 常规检查：`npm run compile`、`npm run test:built`、`npm run test:upstream`、`npm run check:public-boundary`、`npm run check:workflows`。发布或安装遵循用户当次明确范围。

## 唯一运行架构与文档

后端只维护 Rust/Tauri。
产品代码位于 `src-native`、`src/renderer` 和 `src/shared`。
默认构建不得引入第二套后端或桌面运行时。
Toast 高于应用内所有弹窗、菜单和引导层。
修改后执行 `npm run check:runtime-boundary`。

中文技术文档遵循阮一峰的写作规范。
执行要求见 [写作准则](docs/documentation-style-guide.md)。
当前结果以 [公开版整合验收](docs/public-sync-acceptance.md) 为准。

## 开发与测试范围

按 [开发流程](docs/development-testing-workflow.md) 定义状态与断言。
Trace 改动按 [状态矩阵](docs/trace-state-acceptance.md) 选测。
当前公开版没有旧发行版本兼容需求。
不得添加内部旧目录、凭据或更新源迁移。
正常重启保留本版数据，未来原生更新仍分平台验收。
