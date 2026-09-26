# 技术吸收记录

本轮来源：2026-09-26 拉取并核对的远端 `origin/main`，提交 `6ad85c55127c20d1e87f13b6a8276ef05eef3324`。上一轮基线为 `e46c8dbd50c586969dead9979d23502fb7e9d155`。另吸收本地未推送提交 `c673f4d9e8f8e781b5492ee358fada5a267a45af` 中的 macOS 临时目录与 Windows 注册表跨平台修复。

本仓库按能力吸收源码，不引入上游 Git 历史。配置同步与 Excel 转换继续排除，内部品牌、默认连接、额度展示、内部发布脚本和对应专用测试不纳入公开版。

本轮合入：持久服务意图与 Provider 身份、缓存优先目录和后台刷新、统一协议规则、2 秒前台等待、Claude Desktop 模型接入与推理参数透传、启动/退出故障恢复、单文件配置锁、独立重置 worker、便携更新重启失败处理、生命周期通知及共享 UI 组件。新规范保存在 [交互与设计约定](ux-product-requirements.md)。

公开版适配保留：Ark 版本路径与目录候选、通用连接验证、按服务控制 image_gen、字段级旧恢复账本升级、外部配置保护、无限 Trace 保留、元数据诊断和公开发布契约。退出遇到未解除的本地依赖时保持 Gateway 运行。

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
- Trace 永不按条数或空间限额自动删除。设置迁移和 helper 都固定无限保留；删除由用户发起。
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
