# 技术吸收记录

## 2026-10-08 1.0.0 默认策略与折叠入口

版本升为 `1.0.0`。按用户明确要求，新配置默认 Trace 上限 1 GB，默认开启超出上限自动清理；已有明确容量与清理选择保留。客户端与官方模型服务图标分别默认收起，收起保留自定义入口、已保存连接和草稿。此前记录中的无限保留默认值属于旧版本。

## 2026-10-08 模型服务入口与切换回归

七个官方服务使用横向入口，隐藏滚动条和左右箭头，保留触控板横向手势，补充普通鼠标滚轮横向浏览与两端页面滚动，支持键盘聚焦；「自定义」固定在右上角，不重复列出服务菜单。自定义与各预设的未保存草稿分别保留。

补充 Gateway 的已知旧模型名映射，覆盖 HTTP、WebSocket 与压缩请求，保留目标目录有效模型和未知手填模型。官方模型与账户地址分离、目录证据与协议策略、用户主动设置的 Trace 保留策略同时纳入回归。退出恢复遇到外部修改且仍依赖本地端口时保留配置和 Gateway。

明确停止 Trace 恢复所选远端配置并安全停服；隐藏管理器窗口继续保留后台 Gateway。这取代此前停止 Trace 后保留无记录路由的行为，缓存旧地址的客户端需要重新打开。实现与回归入口见 [源码导读](provider-setup-and-routing.md)。

## 2026-10-08 官方账户路由与诊断面板纠正

重新 fetch 后 上游 `origin/main` 仍为 `9b2f522d272681651cc1175eb5bcfd46ae4465db`，本地补充至 `57b8ee1`。对照 `4b29efb` 的诊断面板修改，移除公开版残留的快速修复 / 缓存清理块；面板与上游保持当前问题、最近失败、按问题操作、移除提示及重置交互。公开版手工索引修复保留，移至 Trace 设置分组。配置同步与 Excel 继续排除。

Codex Desktop 0.162.0-alpha.2 要求工作区 backend 为无凭据的 HTTPS origin。普通 Trace 接管与模型页官方 Gateway 均改用 `openai_base_url` 转发模型，不再将 `chatgpt_base_url` 写成本地 HTTP；保留官方 Provider 身份、OAuth 文件和外部账户地址。旧账本恢复仍兼容原字段，读回、就绪检查、本地端点暂挂及上游识别跟进两种地址的分离。


## 2026-10-05 来源与差异审查

重新 fetch 后，远端 `origin/main` 为 `9b2f522d272681651cc1175eb5bcfd46ae4465db`，比上轮 `6ad85c5` 新增 14 个提交。另按能力吸收源工作区本地 `57b8ee19859b9cea6e54b4cbc8e22b3e572a4169` 的 macOS 安装清理修复；该补充不属于此次远端 main。本仓库保留独立 Git 历史，应用版本仍为 `0.1.0`。

| 能力 | 本轮吸收及公开版适配 |
|---|---|
| 自动更新 | Windows 独立 Node worker、启动确认、失败保留恢复文件、过期文件清理；启动检查与夜间检查/下载/安全安装；保留原先窗口显隐状态 |
| 更新可靠性 | 下载并发合并、真正取消网络下载、取消版本跨重启保留；下载及安装前重新核对公开源、版本、文件大小与 SHA-256；拒绝变化的发布清单；启动检查不能覆盖手动下载结果 |
| macOS 安装 | 只下载和校验 DMG，明确确认后打开并安全退出，用户拖入应用程序替换；误从挂载卷运行时先退出，校验复制结果后卸载；新版仅清理已核对的安装包 |
| Claude / ChatGPT | Claude Desktop 停止后的远端配置恢复、仅 Desktop 的重启提示；Messages 与 Chat/Responses 互转、流式工具调用、模型别名；保留官方登录并使用 Provider 专属凭据 |
| 交互设计 | 圆形主题切换、减少动态效果偏好、最后一次选择优先；克制的控件与文案、需 Trace 标记、历史恢复结果确认；诊断保持三列和分页，简化详情 |

仍有意保留的差异：配置同步和 Excel 转换继续排除；没有内部品牌、默认连接、专用 Provider 别名或内部更新服务。通用连接依服务声明选择协议，不根据内部服务的厂商假设推断。Trace 默认无限保留，用户可设置存储上限并开启超出上限自动清理；手动删除/索引修复、元数据诊断、外部配置保护与独立发布渠道保持有效。

自动更新行为见 [发布流程](github-release.md) 和 [交互与设计约定](ux-product-requirements.md)：Windows 在本地 02:00–05:00 的分散时段检查，至少空闲 15 分钟且安全退出检查通过才安装；有活跃回复/工具续接或需要人工确认时推迟。夜间下载不弹出安装确认。macOS 没有自动覆盖安装，也不发布 ZIP 或 `latest-mac.yml`。

2026-10-05 查询公开仓库 GitHub Releases 返回空列表。当前代码具备更新流程，但公开源尚未提供可升级版本；需后续提升版本并正式发布 EXE、DMG 和对应清单，已安装客户端才会收到更新。草稿发布不会进入 latest 更新源。

### 本轮验收

- `compile`、`test:built`、`test:upstream`、`check:public-boundary`、`check:workflows`、`docs:build` 和 `git diff --check` 通过。
- 更新器使用真实本地 HTTP 和临时目录验证下载、并发点击、取消、重启后的取消偏好、损坏文件、来源/版本变化、失败状态及启动检查竞争；Windows 的 NSIS 适配层使用替身，没有执行安装。
- Claude Desktop 入口的 Messages、Chat 流式工具调用、Responses 版本路径、凭据替换和错误返回通过实际本地请求验证。
- macOS arm64 打包应用的 `test:packaged` 与 `test:packaged-gateway` 通过：真实 IPC、126 条诊断分页/搜索/排序/按需详情、原始字段折叠、DMG 下载校验与确认、外部配置保护，以及管理器退出后的无记录转发。修复了合并后分页超出默认窗口的问题，并移除旧的“自动继续模型选择”提示。
- 真实 Chrome/Playwright 在 1280×900、1040×560 检查主题、工具详情、更新确认/稍后/取消及夜间就绪不弹窗；页面内容、弹窗和截图正常，无前端运行错误。Browser plugin 未提供，使用本机 Playwright；Electron 截图由现有脚本保存到 `test-results/packaged-ui/`。

验证应用为本地 `release/verification-20261005/mac-arm64/XwX Deck.app`，仅 ad-hoc 签名，没有 Developer ID 签名、公证、DMG 发布包、安装或线上发布。原生 Windows 文件替换/重启及 macOS Finder 拖拽替换仍需平台验收；挂载检测和安全清理通过隔离模拟测试，不等同于真实 Finder 安装。收尾再次核对远端，main 仍为 `9b2f522`。

## 2026-09-26 来源与范围

来源为当日拉取并核对的远端 `origin/main`，提交 `6ad85c55127c20d1e87f13b6a8276ef05eef3324`。上一轮基线为 `e46c8dbd50c586969dead9979d23502fb7e9d155`。另吸收本地未推送提交 `c673f4d9e8f8e781b5492ee358fada5a267a45af` 中的 macOS 临时目录与 Windows 注册表跨平台修复。

本仓库按能力吸收源码，不引入上游 Git 历史。配置同步与 Excel 转换继续排除，内部品牌、默认连接、额度展示、内部发布脚本和对应专用测试不纳入公开版。

本轮合入：持久服务意图与 Provider 身份、缓存优先目录和后台刷新、统一协议规则、2 秒前台等待、Claude Desktop 模型接入与推理参数透传、启动/退出故障恢复、单文件配置锁、独立重置 worker、便携更新重启失败处理、生命周期通知及共享 UI 组件。新规范保存在 [交互与设计约定](ux-product-requirements.md)。

公开版适配保留：Ark 版本路径与目录候选、通用连接验证、按服务控制 image_gen、字段级旧恢复账本升级、外部配置保护、默认无限且可设置上限/自动清理的 Trace、元数据诊断和公开发布契约。退出遇到未解除的本地依赖时保持 Gateway 运行。

## 2026-09-26 验收结果

- `npm run compile`、`npm run test:built`、`npm run test:upstream` 全部通过。核心 smoke 为 47 组；其余覆盖 helper 协议 14、旧版本升级与原端口接回、后台实际请求、WebSocket 服务切换与续接、2 秒目录等待、Claude Desktop 推理参数、升级迁移失败、重置 worker 和便携更新重启失败。
- `check:docs`、`check:public-boundary`、`check:workflows`、`docs:build` 和 `git diff --check` 通过。远端 main 在验收收尾时仍为上述来源提交。
- macOS arm64 `.app` 的 `test:packaged` 与 `test:packaged-gateway` 通过，使用临时客户端目录和本地模拟服务。验证了真实 IPC、明确接管外部配置、服务切换、Trace 请求落盘、126 条对话分页/搜索/详情、主题、窗口崩溃后重建、退出字段恢复，以及管理器退出后不记录的后台转发。
- 浏览器真实交互检查覆盖 1280×900 与 1040×560、明暗主题、名称校验、密钥显隐、切页保留草稿、保存连接、修复入口和三列对话诊断；无前端运行错误。Browser plugin not available，采用本机 Chrome 与 Playwright。Electron 截图位于本地 `test-results/packaged-ui/`。
- 合并回归额外修复了编辑连接覆盖外部配置、启动错误报告变量不一致、管理器重开时误关缓存转发路由，以及未接管的外部连接阻止退出。保留手动清空记录、索引检查/修复和缓存清理入口。

验证应用位于本地 `release/upstream-verified/mac-arm64/XwX Deck.app`，仅用于本轮验收。使用 ad-hoc 签名；未做 Developer ID 签名、公证、安装、推送或发布。Windows 分支通过隔离模拟回归，未在原生 Windows 上执行本轮安装包验收；本地模拟请求也不代表所有真实服务商账户均已测试。

下表同时记录此前已吸收并继续回归的能力。

| 能力域 | 本次结果 | 验证 |
|---|---|---|
| Trace | 损坏/丢失索引停止写入；手工检查、备份和重建；删除事务保留 | 损坏数据、写入租约、过期修复计划、删除回滚 smoke |
| Gateway | Provider 身份与修订隔离；heartbeat/tool continuation；旧 WebSocket 路由退休；helper 升级 | 核心、helper、升级、后台控制器 smoke |
| 关闭记录 | 恢复客户端磁盘配置，同时保留不记录的转发路由供缓存旧端口的进程继续使用 | Claude/ChatGPT 实际请求与管理器重附着 smoke |
| 对话诊断 | 三列主表、120 条分页、后台 worker、取消、闲置缓存释放、按需详情 | SQLite 元数据与首条 session_meta；正文哨兵、symlink 越界，以及 126 条数据的打包 UI 翻页/搜索/详情 smoke |
| Provider | 独立 registry；旧单连接迁移；两客户端各自选择；连接编辑与模型窗口隔离 | 空安装、A-B-A、陈旧表单、连接失败后编辑、独立 Claude smoke |
| 模型目录 | 本地官方目录；目录缺失保持为空；显式协议与原始路径前缀 | 404/405、外部目录保留、模型能力与真实 Gateway 请求 |
| 配置恢复 | 仅记录实际写入的字段；三方冲突保留；失败回滚；专属凭据直连 | 字段冲突、写后失败、路径变化、Responses/协议转换退出与重启 smoke |
| UI | 多连接选择与编辑；通知去重；引导滚动；代理菜单忙碌状态 | 打包 Electron 的真实 DOM 操作与截图检查 |
| 依赖 | 跟进三项传递依赖补丁；修复基线品牌替换误伤的 20 处随机校验值 | 原始锁文件/官方 registry 核对、全新 npm ci、compile、完整 smoke |

## 分层提交

| 提交 | 层 |
|---|---|
| `c0f6c24` | 冻结现有基线 |
| `aee4396`、`7db454a` | 诊断 worker 与元数据读取边界 |
| `8a3d777` | Trace 索引保护与手工修复 |
| `192aa1a` | Gateway continuation 与连接生命周期 |
| `fc68bbe`、`0be298d` | 独立 Provider registry 与外部配置保护 |
| `79bedb3` | 字段级恢复、退出和不记录的缓存路由 |

后续 UI、依赖与验收脚本单独提交。各层可定位审查；涉及下游依赖的回退按提交逆序执行。

## 保留的产品边界

- appId 为 `app.xwxdeck.desktop`，数据目录为 `xwx-deck`，Gateway 为 `45233-45242`。
- 新安装没有 API Provider。用户手动保存的名称与地址不进行品牌替换。
- 不引入配置同步、Excel client/转换、内部域名与默认连接、内部/LAN 发布或内部历史别名迁移。
- Trace 新配置默认上限 1 GB 并开启超出上限自动清理；已有用户选择保留。手动删除与索引修复由用户发起。
- Tools 只读取 SQLite 元数据与 JSONL 第一条 `session_meta`；不读取后续正文，不返回正文，不修改会话。路径打开验证 Codex home 和真实 symlink 目标。
- 外部 Provider 定义始终保留；不使用上游内部 Provider 名单决定保留或删除。

## 退出恢复的独立裁剪

恢复账本只记录实际写入的根级模型设置、临时能力字段，以及本产品拥有的 Provider 字段。未记录字段不参与恢复，外部变化保留并提示。对已存在的本产品活跃 helper，只在按原值重新发布受验证的端点时登记该 `base_url`。

Responses 连接退出后可直接使用远端和 Provider 专属凭据。Chat Completions / Messages 转换依赖 Gateway；退出保留所选 Provider 身份与远端配置，不自动切回官方。离线直连是否能处理客户端协议由服务本身决定；需要转换的选择会提示开启 Trace。官方 auth.json 使用现有字段级安全恢复。

没有沿用整文件强制回写或任意 localhost 字符串替换。恢复后仍依赖本地端口时取消关闭，保留 Gateway 和恢复证据。关闭窗口继续隐藏管理器；Dock、Cmd+Q、菜单和托盘退出执行配置恢复与停服。

## 验收命令

```sh
npm run compile
npm run test:built
npm run test:upstream
npm run check:public-boundary
npm run check:workflows
npm run docs:build
npm run build:mac:arm64
npm run test:packaged
npm run test:packaged-gateway
```

打包 smoke 使用隔离的客户端目录、模拟上游和本地更新服务，不触碰用户真实会话或服务凭据。版本与发布仍遵循独立 `release-contract.json`；本次不会自动推送、安装或发布产物。

## 诊断界面补充验收

`737b54a` 的后端查询与 worker 已接入，但 Tools 页面仍使用旧的五列全量扫描展示。后续复查补齐了三列布局、分页查询、按需详情和页面活动状态桥接，并把打包验收从“表格存在”加强为验证列名、126 条数据跨页、搜索、排序、详情和刷新时离开再返回。此前的 UI 验收结论未覆盖这些交互，不应视为该层完整移植的证据。
