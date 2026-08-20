# macOS 首次运行

当前公开 macOS 包没有 Developer ID 签名和 Apple 公证。它只能作为开源测试版本分发，macOS 可能阻止首次启动。

## 推荐顺序

1. 将 `XwX Deck.app` 拖入“应用程序”。
2. 在 Finder 中右键应用，选择“打开”。
3. 如果仍被阻止，前往“系统设置 → 隐私与安全性”，确认你信任当前 GitHub Release 后选择仍要打开。
4. 如果系统仍保留下载隔离标记，可以在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/XwX Deck.app"
```

然后重新打开应用。

## 安全提醒

- 只从 [Damue01/XwX_Deck Releases](https://github.com/Damue01/XwX_Deck/releases) 下载。
- 执行命令前核对 Release 中的 SHA-256。
- 该命令会移除该应用的下载隔离属性；不要对来源不明的应用执行。
- 未签名包不等同于经过 Apple 公证的正式发行包。
