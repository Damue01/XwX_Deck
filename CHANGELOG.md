# Changelog

本项目遵循语义化版本。

## [Unreleased]

### Added

- Apache License 2.0 开源框架。
- GitHub Actions、Pages 和 Releases 自动化基础。
- 设置页“诊断与修复”、有边界的应用重置和独立退出恢复进程。

### Changed

- 同步 XwX Deck `main` 的模型能力注册表、价格来源、分档/峰谷/短回复计费和实际服务模型名展示。
- 加入当前 Gateway 实测能力层、推理档位收敛和目录预览/桥接档位诊断工具。
- 修正 Chat Completions usage 双命名归零、缓存 TTL 分桶、跨 Session 用量聚合和费用不完整状态。
- 永久关闭产品级自动 Trace 清理，并将 Session 删除改为“文件暂存 → 索引写入 → 最终删除”的可回滚事务。
- 为已核验的 GPT 长上下文模型增加 272K / 1M 显示选项，并以独立 TOML 数值保存上下文窗口，不改写真实模型 ID。
- 当 XwX Deck 在 ChatGPT 已运行后新接管本地 Gateway 时，通过应用内提示说明需要完整重启 ChatGPT。
- 新增只读的 ChatGPT 对话诊断工具页，可检查 SQLite 索引、Session 元数据、路径、归档状态和 Provider 一致性。
- 保持独立版边界：不加入客户端配置同步或 Excel 转 Markdown。

## [0.1.0]

- 建立独立 XwX Deck 项目。
- 保留 Trace、模型网关、服务商配置和本地仪表盘。
- 移除客户端配置同步、工具页和 Excel 转 Markdown。
