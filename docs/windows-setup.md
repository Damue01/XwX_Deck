# Windows 按用户安装与更新

## 安装范围

Windows 使用独立的 `Setup.exe` 安装程序。
安装引擎为 NSIS，应用后端仍为 Rust/Tauri。
安装不调用 Windows Installer，不重启安装服务。

默认安装到 `%LOCALAPPDATA%\Programs\XwX Deck`。
新装可输入路径，也可浏览目录。
路径必须允许当前用户写入。
现有安装沿用登记位置。
重复运行同一版本可修复程序文件。

应用身份仍为 `app.xwxdeck.desktop`。
配置、账号、日志和 Trace 保存在 `%APPDATA%\xwx-deck`。
安装和卸载不删除数据目录。
新数据目录的连接列表为空。
安装不会导入、激活连接或开启 Trace。

## 界面与维护

安装使用独立的 Windows 页面。
首页采用横向布局，逻辑尺寸为 620×240。
标题在左，路径在右，版本位于左下角。
边缘点阵沿用确认的 C 方案，安装按钮为 58×29。
不显示 Logo、路径横线或安装范围说明。
按用户安装范围由安装引擎保证。
安装位置、实际进度和完成状态分别显示。
不使用 macOS 拖拽图示或默认许可向导。
完成后可选择启动应用。
静默更新由原生助手负责重启。

程序运行时，安装和卸载均停止操作。
请先从托盘退出应用，再重试。
安装程序不强制关闭应用或在途请求。
检查程序在临时目录执行，不占用待替换的 EXE。

替换前保留程序和卸载器的备份。
普通安装失败会恢复文件和安装登记。
预先存在的暂存文件不属于本次安装，拒绝覆盖或删除。
恢复失败会明确报告，并保留恢复文件和日志。
快捷方式在失败恢复时同样保留。
安装日志默认位于临时目录的 `XwXDeck-setup-进程号.log`。
隔离测试可显式指定日志路径。
异常断电、磁盘失效和系统重启需单独验收。

Windows 应用列表登记当前用户安装。
卸载只移除应用文件、登记和所属开始菜单入口。
安装目录中其他文件保留，不递归删除目录。
自启动仅清理指向本安装程序的记录。
用户改为其他目标的快捷方式保留。

## 自动更新

安装版选择同平台、同架构的 `-setup.exe`。
便携版继续选择普通 EXE。
制品清单为两类文件分别记录用途。
两种更新继续使用原来的 GitHub Releases 渠道。

下载和安装前核对大小、SHA-256 和不可变版本清单。
Setup 还要匹配产品、版本、文件身份和按用户安装范围。
回复或工具结果未完成时，拒绝更新并保留下载结果。
助手等待旧进程退出，再执行静默安装。
成功后核对登记版本和程序摘要，重新打开应用。
失败则保留错误与日志，并尝试恢复启动原程序。
明确指定的数据目录会传给助手和新版程序。

## 构建和验收

```powershell
npm run build:win
node tools/native/windows-setup-fixture.mjs --output=test-results/setup-old-debug.exe
node tools/native/windows-setup-test.mjs --old-binary=test-results/setup-old-debug.exe --new-binary="release/XwX Deck.exe" --new-setup="release/XwX Deck Setup.exe"
```

构建生成 `XwX Deck Setup.exe` 和便携版 `XwX Deck.exe`。
NSIS 工具来自 Tauri 官方镜像，使用固定 SHA-256 校验。
安装器呈现层使用小型 Win32 DLL，由 MSVC x86 工具编译。
它只绘制 NSIS 页面，不进入应用运行架构。
许可见 [NSIS 声明](licenses/nsis.txt)。
安装命令定义见 [NSIS 官方参考](https://nsis.sourceforge.io/Docs/Chapter4.html)。

验收拒绝替换已有安装。
测试使用独立程序目录、配置目录和本地更新服务。
覆盖 C/E 盘中文路径、程序占用、失败恢复、修复和重装。
自动更新必须实际下载 Setup，并启动新版原生窗口。
更新后使用保留的配置完成本地模型请求。
卸载检查配置、Trace 和其他用户文件保留。

界面选择目录、键盘操作和完成后启动另做真实交互检查。
签名、公开更新源和系统安全提示继续单独记录。
不把隔离服务成功等同于真实厂商账号验收。
