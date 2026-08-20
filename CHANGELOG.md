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
- 保持独立版边界：不加入客户端配置同步、工具页或 Excel 转 Markdown。

## [0.1.0]

- 建立独立 XwX Deck 项目。
- 保留 Trace、模型网关、服务商配置和本地仪表盘。
- 移除客户端配置同步、工具页和 Excel 转 Markdown。
