# Windows 按用户安装与更新

## 安装范围

MSI 安装包只安装到当前用户。
默认程序目录为 `%LOCALAPPDATA%\Programs\XwX Deck`。
应用身份仍为 `app.xwxdeck.desktop`。
配置、账号、日志和 Trace 保存在原来的 `%APPDATA%\xwx-deck`。
安装和卸载均不删除该数据目录。
新数据目录的连接列表为空。

安装器使用固定的 UpgradeCode。
该标识以 `release-contract.json` 为准。
新版本使用新的 ProductCode。
升级先移除旧程序，再安装新版。
两步位于同一 Windows Installer 事务中。
程序运行时拒绝卸载和覆盖升级。
请先从应用托盘退出，再手动安装或卸载。

按用户安装是安装范围，不是权限修复。
它不授予管理员权限，也不修改文件夹的访问控制。
目录打开仍使用应用的 Windows 文件夹启动接口。
安装上下文见 [Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/msi/installation-context)。

## 自动更新

MSI 版本只选择同平台、同架构的 MSI。
便携版继续选择 EXE，并沿用原路径替换方式。
两种制品来自同一 GitHub Releases 清单。
更新前再次核对版本、大小和 SHA-256。
MSI 还须匹配产品名称、UpgradeCode 和按用户安装范围。

应用安全停止 Gateway 后退出。
独立助手等待旧进程退出，再调用 Windows Installer。
助手在成功安装后核对登记版本，重新打开安装目录中的程序。
失败时保留错误与安装日志，并尝试重新打开原程序。
需要重启 Windows 时明确记录该状态。
卸载不包含删除用户数据的步骤。

## 构建

Windows 构建同时生成 MSI 和便携版。
MSI 使用 WiX 3.14.1。
工具从 WiX 官方 Release 下载，并校验固定 SHA-256。
也可通过 `XWX_WIX_HOME` 指定已有的 WiX 3 工具目录。
安装器结构见 [WiX 文档](https://docs.firegiant.com/wix/schema/wxs/packagescopetype/)。

构建执行 ICE 数据库校验。
安装、卸载和升级仍需分别执行。
生成的工具副本和交付文件使用普通用户的 Medium 完整性级别。
验收目录也使用该级别。
测试目录继承 Low 标签时，会使程序及其子进程降为 Low。
这会阻止程序访问 Windows Installer 服务。
该标签与管理员权限不同。
构建不修改用户数据目录的权限。
机制见 [Microsoft 完整性控制文档](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)。

```powershell
npm run compile
node tools/native/build.mjs --acceptance --require-platform=win32 --require-arch=x64
```

## 隔离验收

验收前检查当前用户没有已登记的 XwX Deck MSI。
脚本拒绝覆盖已有安装。
测试使用独立程序目录、带标记的数据目录和本地更新服务。
先构建真实旧版本，再验证新版安装包。
测试副本不会读取日常使用的配置或对话。

```powershell
node tools/native/windows-msi-fixture.mjs --output=test-results/msi-old-debug.exe
node tools/native/windows-msi-test.mjs --old-binary=test-results/msi-old-debug.exe --new-binary="release/XwX Deck.exe"
```

检查包含中文及空格路径、保留配置和 Trace、运行中拒绝卸载。
升级必须实际下载 MSI，退出旧程序并渲染新版。
随后用保留的服务完成本地请求。
最后卸载、重装并再次卸载。
测试同时检查被修改的安装包和失败后的原程序恢复。
结果、日志和安装包摘要写入本次隔离目录。
公开更新源、签名和安全提示仍需在发布候选上单独核对。
