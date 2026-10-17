# 整合验收

Intel Mac 首轮候选已完成原生构建与隔离验收。
制品哈希、运行结果与边界见 [GitHub 发布流程](../github-release.md#intel-mac-首轮验收)。
本轮未发布新版本，下载入口保持现状。

最新平台结果见 [1.0.0 平台整合验收](platform-integration-acceptance.md)。
Windows 最终候选已包含固定端口和 API 接管清理。
96 组后端实际执行通过，1 组 Unix 专属场景跳过。
同包原生界面、退出释放端口和重开检查通过。
人工视觉仍因锁屏待验，正常安装未替换。

以下保留此前候选的验收记录。
当前 Windows 结果以上述独立记录为准。

本轮已重新生成 `1.0.0` 签名、公证包。
当前验收和发布边界见 [1.0.0 重新打包](release-1-0-0-acceptance.md)。

旧会话的本地连接接管、停止恢复与重载提示已修复源码。
详情与验收边界见 [旧会话连接与续接](continuation-routing-acceptance.md)。
固定端口与 API 接管清理为后续源码补充，尚未替换正常安装。

详情页网格、实心展开图标和 40 px 侧栏已进入最新本地 Mac 候选。
制品与验收结果见 [详情布局与本地候选](trace-detail-layout-acceptance.md)。

最新本地候选包含分页对比的正文读取修复。
包内专项与性能样本见 [Trace 加载与对比复核](trace-reading-compare-acceptance.md)。

最新本地 Mac 包已包含 compact、阅读与安装背景修复。
最终制品与验证边界见 [Mac 最终候选](macos-final-candidate-acceptance.md)。
精确哈希、公证和验证边界见 [Gateway 重新打包](gateway-package-acceptance.md)。

当前源码版本为 `1.0.0`。

本次修改与候选证据见 [Trace 与安装包修复](trace-installation-acceptance.md)。
本轮只更新源码、测试与文档。
应用安装、版本标签与 Release 保持原状。

## 改动范围

| 部分 | 当前行为 |
| --- | --- |
| 架构 | Rust/Tauri 后端。前端与共享资源独立。 |
| 仪表盘 | 会话单行，无 LIVE。已知金额无星号。 |
| 计价 | models.dev 主源。每请求保存价格快照。 |
| 阅读 | 200 条摘要。连续预取与稳定阅读位置。 |
| 通知 | Toast 高于卡片、菜单和引导。 |
| 服务 | 显式选择保留。跨服务切换默认关闭。 |
| 账号 | 官方与 API 分组。凭据与身份分别保护。 |
| 生命周期 | 安全停止、恢复、重置和索引修复。 |
| 官网 | 首屏价值、分屏预览与明确下载反馈。 |

## 产品边界


应用 ID 为 `app.xwxdeck.desktop`。
数据目录为 `xwx-deck`。
新安装的服务列表为空。
Gateway 固定监听 `127.0.0.1:45233`，端口占用时明确报错。
更新只使用公开 GitHub Releases。
macOS 继续采用手动 DMG 更新。

不提供工具页、配置同步与对话诊断。
相关后端、接口、类型和页面均排除。
仓库边界检查源码、当前构建与本地 Git 历史。
压缩后的变量名按语法解析。
真实品牌字符串与属性仍严格检查。
这些检查属于仓库隐私约束。
应用不屏蔽用户输入中的品牌词。

## 测试与状态

完整工程检查的 8 个阶段全部通过。
检查期间源码指纹保持不变。
本机结果见 [测试记录](integration-test-results.json)。

| 类型 | 本轮结果 |
| --- | --- |
| Rust | 113 项单元测试。格式与严格静态检查通过。 |
| 原生后端 | 86 组执行通过。Windows 替换场景单独跳过。 |
| 原生界面 | 主界面 207 项，阅读窗口 21 项。 |
| 完整重置 | 15 项。自动重启并清理自己的测试存储。 |
| 浏览器 | 仪表盘 12 项、阅读 6 项、Toast 4 组、官网 5 项。 |
| 模型切换 | 25 项异步顺序与目录刷新回归通过。 |
| 依赖 | 安全审计发现 0 项已知漏洞。 |

原生界面发送了 2 次本地流式请求。
已安装的 Codex 与 Claude CLI 也完成隔离回归。
这些请求使用合成上游与测试配置。
没有读取或替换日常客户端的凭据。

测试清单包含 13 个模块、72 个要求。
59 个脚本入口是测试映射，不能视为全部实测通过。
测试要求见 [功能清单](../core-functional-acceptance-checklist.md)。
执行方式见 [测试策略](../testing-strategy.md)。

真实授权、账单和物理操作单独验收。
Windows、最低 macOS 和多屏操作仍待补验。
Codex 侧聊目前只有设计预览。
本次不将该预览声明为产品能力。

## 后续维护

执行 `npm run check:quality` 检查工程合同。
执行 `npm run check:public-boundary` 检查公开范围。
中文文档遵循 [写作准则](../documentation-style-guide.md)。
Linux CI 的构建依赖按 [Tauri 官方说明](https://v2.tauri.app/start/prerequisites/) 配置。
远端 CI 结果需在推送后单独核对。
