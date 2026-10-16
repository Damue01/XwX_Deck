# macOS 安装

公开版新候选从 1.0.0 重新编号。
签名构建分别校验 App 和 DMG。
每个包需要完成 Apple 公证和票据装订。
本次候选状态见 [验收记录](trace-installation-acceptance.md)。

## 安装与更新

1. 下载对应的 Apple Silicon Mac 安装包。
2. 核对候选记录或发布页的 SHA-256。
3. 打开 DMG，将 `XwX Deck.app` 拖入“应用程序”。
4. 替换旧版前，关闭 Trace 并退出旧应用。

macOS 继续采用手动 DMG 更新。
签名包不再附带首次放行提示。
当前没有 Intel Mac 发行包。

## 版本边界

重新编号不会自动将已安装的 1.1.1 降级。
首次切换到 1.0.0 需要手动安装。
后续更新只接受 `native-v1` 发行序列。
本地构建与公开发布分别记录。
