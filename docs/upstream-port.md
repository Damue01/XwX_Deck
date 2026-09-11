# 技术吸收记录

来源冻结于本地已验证的 `origin/main`：`e46c8dbd50c586969dead9979d23502fb7e9d155`。移植以能力域为单位，没有合并上游分支；本仓库从 `c0f6c24` 基线继续维护独立历史。

| 能力域 | 本次结果 | 验证 |
|---|---|---|
| Trace | 损坏/丢失索引停止写入；手工检查、备份和重建；删除事务保留 | 损坏数据、写入租约、过期修复计划、删除回滚 smoke |
| Gateway | Provider 身份与修订隔离；heartbeat/tool continuation；旧 WebSocket 路由退休；helper 升级 | 核心、helper、升级、后台控制器 smoke |
| 关闭记录 | 恢复客户端磁盘配置，同时保留不记录的转发路由供缓存旧端口的进程继续使用 | Claude/ChatGPT 实际请求与管理器重附着 smoke |
| 对话诊断 | 后台 worker、分页、取消、缓存释放、详情按需加载 | SQLite 元数据与首条 session_meta；正文哨兵和 symlink 越界 smoke |
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

恢复账本只记录根级模型设置、临时能力字段，以及本产品的 `model_providers.xwx_deck` 字段。未记录字段不参与恢复，外部变化保留并提示。对已存在的本产品活跃 helper，只在按原值重新发布受验证的端点时登记该 `base_url`。

Responses 连接退出后可直接使用远端和 Provider 专属凭据。Chat Completions / Messages 转换依赖 Gateway，完整退出会恢复官方直连并保留连接选择；下次启动继续使用保存的选择。官方 auth.json 使用现有字段级安全恢复。

没有沿用整文件强制回写或任意 localhost 字符串替换。恢复后仍依赖本地端口时取消关闭，保留 Gateway 和恢复证据。关闭窗口继续隐藏管理器；Dock、Cmd+Q、菜单和托盘退出执行配置恢复与停服。

## 验收命令

```sh
npm run compile
npm run test:built
npm run check:public-boundary
npm run check:workflows
npm run docs:build
npm run build:mac:arm64
npm run test:packaged
npm run test:packaged-gateway
```

打包 smoke 使用隔离的客户端目录、模拟上游和本地更新服务，不触碰用户真实会话或服务凭据。版本与发布仍遵循独立 `release-contract.json`；本次不会自动推送、安装或发布产物。
