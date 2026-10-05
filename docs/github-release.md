# GitHub 发布流程

## Pull Request

`.github/workflows/ci.yml` 会运行：

- TypeScript 和 Electron 编译；
- Core、Gateway helper 和 Controller smoke；
- 更新取消/完整性/夜间策略、Claude 协议、主题与会话确认回归；
- 文档构建；
- 公共边界与 workflow 检查；
- Windows 和 macOS 原生编译。

## 文档

`main` 中的文档变化会触发 `.github/workflows/pages.yml`，将 VitePress 输出部署到：

```text
https://damue01.github.io/XwX_Deck/
```

首次使用前需要在仓库 Settings → Pages 中将 Source 设为 **GitHub Actions**。

## Release

发布前：

1. 更新 `package.json` 版本。
2. 更新 `CHANGELOG.md`。
3. 确认 CI 全部通过。
4. 创建相同版本标签：

```bash
git tag v0.1.0
git push origin v0.1.0
```

Release workflow 会：

1. 在原生 Windows x64 Runner 构建 EXE。
2. 在原生 macOS arm64 Runner 构建 DMG。
3. 生成 `latest.yml`、`release.json`、SHA-256 和 `checksums.txt`。
4. 生成 GitHub Artifact Attestation。
5. 创建 Draft Release 并上传全部文件。

workflow 不会自动公开 Release。维护者必须检查：

- 标签、`package.json` 和清单版本一致；
- Windows、macOS 文件齐全；
- SHA-256 正确；
- macOS Release 明确标注未签名、未公证；
- 没有内部地址、密钥或私人路径。

确认后再在 GitHub 中发布 Draft。

## 自动更新

客户端默认读取：

```text
https://github.com/Damue01/XwX_Deck/releases/latest/download
```

Windows 使用 `latest.yml`，macOS 手动更新使用 `release.json` 和其中的完整 Release asset URL。

Windows 清单的 EXE URL 绑定具体版本标签，下载与安装前复查 `release.json`；同版本替换文件不视为新版本。发布更新必须提升 `package.json` 版本，生成匹配标签，并公开经审核的 Release。

Windows 保持运行时，会在本地时间 02:00–05:00 静默下载，空闲至少 15 分钟且安全退出检查通过才自动安装；用户取消的版本跨重启不再自动安装。macOS 不执行夜间安装，用户确认后打开 DMG、安全退出，再手动替换。

2026-10-05 回读公开仓库时 Release 列表为空。当前更新流程通过本地模拟服务验证；合并源码或创建草稿都不会让已安装客户端收到更新。本轮未创建标签或发布制品。
