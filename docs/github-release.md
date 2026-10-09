# GitHub 发布流程

## Pull Request

`.github/workflows/ci.yml` 运行 React 与构建时 TypeScript 资源编译、原有 Core / Gateway / Controller 对照回归、上游修复回归、文档与公开边界检查。在原生 Windows x64 和 macOS arm64 Runner 构建 Rust / Tauri，运行隔离目录内的真实后端请求、导入、订阅轮换和更新校验；macOS 另外验证真实 WebKit 窗口。

旧 TypeScript 后端用于回归对照和生成 Viewer / 价格资源，不进入正式安装包。

## 文档

`main` 的文档变化触发 Pages workflow，部署到 [XwX Deck 文档](https://damue01.github.io/XwX_Deck/)。仓库 Settings → Pages 的 Source 应为 **GitHub Actions**。

## Release

1. 同步 `package.json`、`package-lock.json`、`src-native/Cargo.toml`、`Cargo.lock` 和 `tauri.conf.json` 版本。
2. 更新 `CHANGELOG.md` 和版本相关文档。
3. 完成 CI 与本地验收，记录仍需真实账号或系统权限验证的边界。
4. 推送对应版本标签，例如：

```bash
git tag v1.1.0
git push origin v1.1.0
```

Release workflow 在原生 Windows / macOS Runner 构建正式 EXE / DMG，并运行实际可执行文件的隔离后端和界面回归。Windows 更新进程必须完成等待旧进程退出、文件替换、SHA-256 校验和新版启动；启动失败时检查新文件与旧版备份保留，不能默默启动旧版。macOS 使用正式应用包中的 WebKit 验收。

两个平台都成功后，受保护的 `release` environment 才组装 Draft Release，上传制品、不可变版本 URL 的 `release.json`、`latest.yml`、校验文件和 GitHub Artifact Attestation。应用内的更新摘要来自对应版本的 CHANGELOG。

草稿不属于公开发布，不会成为默认更新源。发布前确认标签、版本、制品身份、架构、哈希、许可证及验证结果一致，随后公开草稿。不要覆盖已公开的相同版本文件。

## 更新行为

Windows 下载和安装前复查清单及 SHA-256，替换可写目录中的原路径 EXE并保留恢复备份。夜间更新在 02:00–05:00 且空闲至少 15 分钟、Gateway 关闭和退出恢复成功时才安装；已取消版本跨重启保持取消。

macOS 只下载并校验 DMG，用户确认后打开安装包、安全退出，再手动替换。当前没有 Developer ID 签名或 Apple 公证，不提供静默安装。首次打开见 [macOS 安装说明](macos-first-run.md)。

## 验证公开制品

公开后运行 **Verify published update** workflow，输入最新版本标签。该流程匿名读取默认 GitHub 源中的清单和制品，核对版本、不可变 URL、大小、SHA-256 与旁路校验文件。下载的正式可执行文件在隔离目录中验证界面与语言重启；Windows 验证实际更新进程的替换与启动，Mac 只读挂载 DMG、复制应用、验证身份、架构与签名后启动。

Actions 中的 `published-update-Windows` / `published-update-macOS` artifacts 保存 `published-native-*.json`。成功记录才表示公开制品已验证。该流程不声称已经将任意用户的真实旧安装升级；旧 Electron 设置迁移由隔离迁移回归单独覆盖。源码检查或本地 HTTP 测试不能替代公开源验证。
