# 原生构建与回归

后端使用 Rust/Tauri，界面使用现有 React 前端。
Viewer 与价格资源来自 `src/renderer` 和 `src/shared`。
构建不读取正常用户配置。

## 常用命令

```sh
npm ci
npm run check:quality
npm run check:test-plan
npm run check:workflows
npm run docs:build
npm run build:native:isolated
```

`check:quality` 绑定当前源码指纹。
它检查前端、共享合同和原生资源。
随后执行 Rust 格式、Clippy、单元与后端回归。
每个后端套件使用独立进程和配置目录。
失败保留日志，平台不适用项标记跳过。

## 界面与真实服务

原生界面检查使用 `native-test.mjs`。
浏览器分别检查仪表盘、分页和通知层级。
已安装 CLI 只在隔离 HOME 中访问合成上游。
这不能替代真实授权或费用账单验收。
Windows 的系统集成需要原生 Windows 主机。

## 构建与运行

隔离构建输出到 `test-results/rust-pilot-package`。
启动器创建独立目录并核对候选指纹。
正常应用身份、数据与进程保持原状。
正式输出沿用 `release-native` 和 `release`。
构建不安装、上传或发布。

## 可选签名验证

默认公开候选保持未签名状态。
签名命令需要维护者提供独立 Apple 配置。
配置文件为 `assets/macos/native-release.json`。
包含团队 ID、签名身份和公证配置名称。
仓库不预置这些个人配置。
本轮源码同步不执行签名或公证上传。
