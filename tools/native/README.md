# Rust 原生运行时

`src-native` 是产品的原生外壳和后端；原有 React 页面通过 `bridge.ts` 调用 Rust。发行包不携带 Electron、Node 或 Chromium。`src/main` 中的旧 TypeScript 实现保留为迁移回归对照和构建时的 Viewer、价格规则生成来源，不进入原生发行包。

保留模型、设置和 Trace 页面，移除工具页及对话诊断。macOS 使用系统标题栏、红黄绿按钮和 WebKit；Windows 使用系统 WebView2 和原有窗口控件。

后端包含独立客户端配置、字段恢复账本、官方 OAuth、Responses / Chat / Messages 转换、SSE、原生 Responses WebSocket、续接缓存、Trace JSONL / 索引 / 用量 / 计费、显式历史归并和恢复、Claude Desktop、修复、目录和登录项、更新清单与校验。窗口关闭后 Gateway 可继续工作，托盘或 Dock 可重新打开；主动退出需要先完成配置恢复。Windows 便携版更新由单独复制的原生进程等待旧进程退出、校验和替换文件，保留恢复备份。

## 本地构建与验证

要求 Node.js 22.12+、npm 11、Rust stable；Mac 需要 Command Line Tools，Windows 需要 MSVC 和 WebView2。

```sh
npm run build:rust:pilot
npm run test:rust
npm run start:rust:isolated
npm run build:rust
```

试验构建在 `test-results/rust-pilot-package`，使用独立应用身份，且启动时必须指定隔离目录。验证与本地 HTTP / WebSocket 服务都使用 `--pilot-root`，不会读取真实客户端目录、注册登录项或安装更新。首次隔离目录必须为空，不能使用符号链接。`--rpc`、`--smoke` 必须显式指定隔离目录。

正式 Mac 候选包输出到 `release-native`，Windows EXE 到 `release`。`npm start` 使用正式原生运行时和 `xwx-deck` 配置目录；不要用它做隔离验证。构建只生成本地候选包，不安装、上传或发布。Mac 使用 ad-hoc 签名，没有公证，更新为手动 DMG。

Rust release 使用 `opt-level=z`、LTO、单个 codegen unit、panic abort 和 strip；资源嵌入压缩，TLS、WebKit、Mac SQLite 使用系统实现。Mac 构建比较 zlib、bzip2 和 LZFSE 压缩，并保留许可证、首次打开说明及 Applications 拖拽入口。体积实测记录在 `native-build-report.json`。

`test:rust:backend` 覆盖本地真实请求、协议转换、官方登录路由、WebSocket、续接、配置恢复与冲突、崩溃恢复、目录、历史元数据、Desktop 和更新下载。`native-test.mjs` 在实际系统 WebView 中验证原有表单、侧栏、主题、Trace 按钮、实时仪表盘与详情交互和窗口隐藏后的请求。旧 Trace 索引的累计与每日用量直接沿用；缺少可靠计费信息时标记费用不完整。原生菜单可查看压缩嵌入的第三方许可证。Windows 的编译、WebView2、便携更新和系统登录项仍需要原生 Windows 主机验证；Mac 的隔离验证不会修改真实登录项。

`portability-test.mjs` 使用隔离目录和本地 HTTP 服务验证同端口热切换、两个客户端的请求快照、增量转换、残缺工具拒绝、图片和推理往返、会话续接、原生响应缓存与压缩来源恢复。转换流不盲目重试，已知不能恢复的外来压缩会明确失败。转换和订阅路由的 WebSocket 仍不支持，客户端需走 HTTP SSE；已有会话但没有本地来源记录的不透明状态无法保证跨服务续接。这里的回归不等同于真实服务商套餐额度或所有私有协议的验证。

## 独立客户端回归

`node tools/native/client-models-renderer-test.mjs [仓库目录]` 用真实 React/Base UI 选择框验证迟到回读、目录失败、导航、保存失败重试和运行状态竞态，桥接层为合成夹具。

真实 Pi 可临时安装官方 `@earendil-works/pi-coding-agent`，无需全局安装。设置 `XWX_INSTALLED_PI` 为其 JavaScript CLI 入口后运行 `node tools/native/gateway-clients-test.mjs`，或在完整后端测试中自动加入此套件。测试使用独立 HOME、关闭扩展/工具/遥测和启动联网、本地拒绝外网的代理及合成授权，验证实际 CLI 读取生成配置、切换 Provider/模型、协议转换、Trace 停止直连和外部编辑保留。还可设置 `XWX_INSTALLED_OPENCODE` 为官方 OpenCode 可执行文件，同一套件顺序验证两个客户端，不重复维护请求服务与生命周期断言。不设置相应变量时，不宣称已验证该客户端。运行中的交互会话是否自动重载及真实平台授权仍须单列。
