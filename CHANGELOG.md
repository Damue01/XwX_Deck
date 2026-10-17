# Changelog

本项目遵循语义化版本。

## [Unreleased]

## [1.0.0] - 2026-10-17

首次正式对外发布。

### 功能

- 使用 Rust / Tauri 和系统 WebView，提供 Windows x64、Apple Silicon 和 Intel Mac 安装包。
- 集中管理 API 服务、Coding Plan、订阅账号与客户端配置，支持只读预览导入。
- 为已接入客户端切换模型服务，通过本地 Gateway 适配协议与兼容的上下文。
- 使用 Trace 和仪表盘查看请求、响应、工具调用、Token、参考费用与耗时。
- 提供简体中文与 English、本地配置与日志、客户端检测、诊断修复及安全退出恢复。

### 数据与更新

- 新安装不预设 API 连接，保留用户明确选择及外部配置变化。
- Trace 默认上限为 1 GB，自动清理只删除正文，保留用量统计。
- Windows 使用便携 EXE；Mac 使用 DMG 拖拽安装和手动替换。
- 安装包、更新清单与 SHA-256 校验文件统一从本仓库发布页提供。
