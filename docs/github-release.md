# GitHub 发布流程

## Pull Request

`.github/workflows/ci.yml` 检查当前源码。
Ubuntu 运行完整工程门禁、文档和仓库边界检查。
Windows x64、Apple Silicon 和 Intel Mac Runner 构建 Rust/Tauri 隔离候选。
随后运行原生后端请求与生命周期回归。
macOS 另行验证实际 WebKit 窗口。

后端统一使用 Rust。
React、TypeScript 和 Node.js 用于界面、构建和测试。
旧 TypeScript 后端已移除。
Viewer 与价格资源由当前共享模块生成。
真实授权、账单和物理操作另行验收。

## 文档

`main` 的文档变化触发 Pages workflow，部署到 [XwX Deck 文档](https://damue01.github.io/XwX_Deck/)。仓库 Settings → Pages 的 Source 应为 **GitHub Actions**。

## 候选包

在 Actions 中手动运行 **Build desktop packages**。
选择 `main`，将 `target` 保持为默认的 `all`。
一次运行会分别构建以下三个候选包。

| 系统 | 架构 | 下载 artifact | 文件 |
| --- | --- | --- | --- |
| Windows | x64 | `windows-x64` | `XwX-Deck-windows-x64-setup.exe`，另附便携版 `XwX-Deck-windows-x64.exe`。 |
| Mac | Apple Silicon | `macos-arm64` | `XwX-Deck-mac-arm64.dmg` |
| Mac | Intel | `macos-x64` | `XwX-Deck-mac-x64.dmg` |

也可选择 `windows-x64`、`macos-arm64` 或 `macos-x64`，只构建对应候选。
命令行可在仓库目录执行：

```bash
gh workflow run release.yml --ref main -f target=all
```

三个目标分别使用原生 Windows、Apple Silicon 和 Intel Runner。
每个目标执行 Rust 单测、隔离后端与实际 WebView 回归。
Mac 额外校验 Mach-O 架构、应用签名和 DMG 完整性。
验证记录分别位于 `windows-verification`、`macos-arm64-verification` 和 `macos-x64-verification` artifact。

Mac 候选使用 ad-hoc 签名，未完成 Developer ID 签名和公证。
此操作不创建标签、Release 或更新清单。
下载入口在正式发布和制品验收后另行调整。

正式分发前，Apple Silicon 与 Intel Mac 制品均需完成 Developer ID 签名、公证和票据装订。
验收记录绑定签名后的可执行文件与最终 DMG。

## Release

1. 同步 `package.json`、`package-lock.json`、`src-native/Cargo.toml`、`Cargo.lock` 和 `tauri.conf.json` 版本。
2. 更新 `CHANGELOG.md` 和版本相关文档。
3. 完成 CI 与本地验收，记录仍需真实账号或系统权限验证的边界。
4. 推送对应版本标签，例如：

```bash
git tag v1.0.1
git push origin v1.0.1
```

Release workflow 在原生 Windows / macOS Runner 构建正式 EXE / DMG，并运行实际可执行文件的隔离后端和界面回归。Windows 更新进程必须完成等待旧进程退出、文件替换、SHA-256 校验和新版启动；启动失败时检查新文件与旧版备份保留，不能默默启动旧版。macOS 使用正式应用包中的 WebKit 验收。

Windows x64、macOS arm64 和 macOS x64 三个目标都成功后，受保护的 `release` environment 才组装 Draft Release，上传制品、不可变版本 URL 的 `release.json`、`latest.yml`、校验文件和 GitHub Artifact Attestation。应用内的更新摘要来自对应版本的 CHANGELOG。

草稿不属于公开发布，不会成为默认更新源。发布前确认标签、版本、制品身份、架构、哈希、许可证及验证结果一致，随后公开草稿。不要覆盖已公开的相同版本文件。

## 更新行为

Windows 下载和安装前复查清单及 SHA-256，替换可写目录中的原路径 EXE 并保留恢复备份。夜间更新在 02:00–05:00 且空闲至少 15 分钟、Gateway 关闭和退出恢复成功时才安装；已取消版本跨重启保持取消。

macOS 只下载并校验 DMG，用户确认后打开安装包、安全退出，再手动替换。不提供静默安装。签名、公证和票据装订状态以具体制品的验收记录为准。首次打开见 [macOS 安装说明](macos-first-run.md)。

## 验证公开制品

公开后运行 **Verify published update** workflow，输入最新版本标签。该流程匿名读取默认 GitHub 源中的清单和制品，核对版本、不可变 URL、大小、SHA-256 与旁路校验文件。下载的正式可执行文件在隔离目录中验证界面与语言重启；Windows 验证实际更新进程的替换与启动，Mac 只读挂载 DMG、复制应用、验证身份、架构与签名后启动。

Actions 中的 `published-update-Windows-X64`、`published-update-macOS-ARM64` 和 `published-update-macOS-X64` artifacts 保存 `published-native-*.json`。成功记录才表示公开制品已验证。该流程不声称已经将任意用户的真实旧安装升级；旧 Electron 设置迁移由隔离迁移回归单独覆盖。源码检查或本地 HTTP 测试不能替代公开源验证。

## Intel Mac 首轮验收

2026 年 10 月 17 日的 [候选构建](https://github.com/Damue01/XwX_Deck/actions/runs/39003598139) 已通过。
源码提交为 `788eccf6458024da31e399094f631da58539dfc0`，构建工作区干净。
后续提交只调整 CI 时限与验收记录。

| 项目 | 结果 |
| --- | --- |
| 环境 | `macos-15-intel`，原生 `x86_64`。 |
| 版本与身份 | `1.0.0`，`app.xwxdeck.desktop`。 |
| 制品 | `XwX-Deck-mac-x64.dmg`，9,458,559 字节。 |
| Rust 单测 | 161 项通过。 |
| 后端回归 | 96 组执行通过，1 组 Windows 专属场景跳过。 |
| 包内 WebKit | 主界面 232 项、Viewer 28 项通过，发送 2 次本地请求。 |
| 独立复核 | DMG 完整性、只读挂载、架构、身份、严格签名与哈希一致。 |
| 签名与发布 | ad-hoc 签名，未公证；未替换正常安装，未发布 Release。 |

DMG SHA-256 为 `4ab3bfd3cde13d39da198558d9228d4d03f16afd428914c3cd1241c4433d9268`。
包内可执行文件 SHA-256 为 `1a87f38b3bb99f5d8831fc42083bedd639b33a4a617d8076201d59c5a8281f3c`。
源码指纹为 `ef672b9ca2e3338783ff0711ef09b895f30b46cfd631b3201db435ac48802f19`。
该指纹按 Runner 检出字节计算；依照 `.gitattributes` 的换行规则复核一致。

后端回归使用编译输出，SHA-256 为 `0a5baf1ac6267a98627e8b6c856a7ab388f4d6c528523316e74a094c6b48a2ed`。
应用签名会改变可执行文件哈希。
包内 WebKit 与 Viewer 检查绑定签名后的可执行文件。
这些结果来自隔离配置和合成上游。
真实账号、最低 macOS 版本与人工拖拽安装仍需另验。

首次构建在新增的架构校验处失败，原因是 `lipo` 参数顺序错误。
修复后，上述候选流程完整通过。
普通 Intel CI 的后端回归通过，界面检查触及 30 分钟总时限。
Intel CI 时限已调整为 45 分钟，重跑结果以 Actions 为准。
Windows 与 Apple Silicon 的本轮 CI 均已通过。
