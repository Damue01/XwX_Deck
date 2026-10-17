# 自动化脚本入口映射

本文件由 `node tools/checks/report-test-coverage.mjs --write` 生成。
来源为功能目录、后端清单和 `test:built` 命令。
脚本入口不代表子场景全部覆盖，也不代表本次执行通过。
断言与真实环境要求见 [开发流程](development-testing-workflow.md) 和 [Trace 状态矩阵](maintenance/trace-state-acceptance.md)。

后端默认入口由 `test:native:backend` 执行。
`check:quality` 编译当前源码后调用该入口。
`test:built` 入口也属于工程门禁。
条件入口依赖环境和已安装客户端。
独立专题入口需要另行选择，不能假设默认门禁已执行。
本表只展开 npm 命令直接列出的脚本。
包装脚本内部的导入、Rust 单测与原生界面套件需按各自报告核对。
平台跳过、真实授权与付费生成另行登记。

## TR Trace 捕获与会话归类

功能编号：`TR01`、`TR02`、`TR03`、`TR04`、`TR05`、`TR06`、`TR07`、`TR08`、`TR09`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [claude-native-sessions-test.mjs](../tools/native/claude-native-sessions-test.mjs) | 后端默认入口 | TR01 |
| [client-trace-defaults-test.mjs](../tools/native/client-trace-defaults-test.mjs) | 后端默认入口 | TR01、CL01 |
| [codex-client-compatibility-test.mjs](../tools/native/codex-client-compatibility-test.mjs) | 后端默认入口 | TR05、MO01、CL01、CL02 |
| [dashboard-layout-test.mjs](../tools/native/dashboard-layout-test.mjs) | 独立专题入口 | TR08、CO03 |
| [official-websocket-proxy-test.mjs](../tools/native/official-websocket-proxy-test.mjs) | 后端默认入口 | TR07 |
| [portability-test.mjs](../tools/native/portability-test.mjs) | 后端默认入口 | TR01、TR02、TR03、TR04、TR05、TR06、TR07、TR09、CL01、CL02、CL03、CL04、CL05、CL07、CL08 |
| [routing-consumption-test.mjs](../tools/native/routing-consumption-test.mjs) | 后端默认入口 | TR01、TR02、TR07、MO03、MO06、CL01、CL02、CL05、CL06、LF03 |
| [session-reading-renderer-test.mjs](../tools/native/session-reading-renderer-test.mjs) | 独立专题入口 | TR08 |
| [tool-wait-test.mjs](../tools/native/tool-wait-test.mjs) | 后端默认入口 | TR06、LF01、LF02、LF04、LF05 |
| [trace-client-evidence-test.mjs](../tools/native/trace-client-evidence-test.mjs) | 后端默认入口 | TR01、TR02、TR03、TR04、TR07、TR09 |
| [trace-dashboard-api-test.mjs](../tools/native/trace-dashboard-api-test.mjs) | 独立专题入口 | TR08 |
| [trace-native-sessions-test.mjs](../tools/native/trace-native-sessions-test.mjs) | 后端默认入口 | TR01、TR02、TR03、TR04、TR06、TR07、TR09 |
| [trace-session-navigation-test.mjs](../tools/native/trace-session-navigation-test.mjs) | 后端默认入口 | TR08 |
| [trace-viewer-renderer-test.mjs](../tools/native/trace-viewer-renderer-test.mjs) | 后端默认入口 | TR01、TR02、TR03、TR04、TR07、TR08、TR09、CO03 |

## CO 用量、参考费用与统计

功能编号：`CO01`、`CO02`、`CO03`、`CO04`、`CO05`、`CO06`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [catalog-contract-edges-test.mjs](../tools/native/catalog-contract-edges-test.mjs) | 后端默认入口 | CO05、MO01、MO02、MO03、MO05、MO06 |
| [dashboard-layout-test.mjs](../tools/native/dashboard-layout-test.mjs) | 独立专题入口 | TR08、CO03 |
| [models-dev-unification-test.mjs](../tools/native/models-dev-unification-test.mjs) | 后端默认入口 | CO02、CO04、MO01、MO06 |
| [price-catalog-test.mjs](../tools/native/price-catalog-test.mjs) | 后端默认入口 | CO02、CO03、CO04、CO05、CO06 |
| [trace-billing-test.mjs](../tools/native/trace-billing-test.mjs) | 后端默认入口 | CO02、CO03、CO04、CO06 |
| [trace-cache-usage-test.mjs](../tools/native/trace-cache-usage-test.mjs) | 后端默认入口 | CO01、CO03、CO04、CO06 |
| [trace-clients-renderer-test.mjs](../tools/native/trace-clients-renderer-test.mjs) | 独立专题入口 | CO06、UI02、UI03、UI05 |
| [trace-viewer-renderer-test.mjs](../tools/native/trace-viewer-renderer-test.mjs) | 后端默认入口 | TR01、TR02、TR03、TR04、TR07、TR08、TR09、CO03 |
| [models-dev-unification-test.mjs](../tools/shared-core/models-dev-unification-test.mjs) | test:built 入口 | CO02 |
| [trace-cache-rate-test.mjs](../tools/shared-core/trace-cache-rate-test.mjs) | test:built 入口 | CO06 |

## MO 模型服务、目录与协议

功能编号：`MO01`、`MO02`、`MO03`、`MO04`、`MO05`、`MO06`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [catalog-contract-edges-test.mjs](../tools/native/catalog-contract-edges-test.mjs) | 后端默认入口 | CO05、MO01、MO02、MO03、MO05、MO06 |
| [catalog-contract-test.mjs](../tools/native/catalog-contract-test.mjs) | 后端默认入口 | MO01 |
| [client-models-renderer-test.mjs](../tools/native/client-models-renderer-test.mjs) | 后端默认入口 | MO04、CL01、CL03、CL04、CL05、CL07、CL08 |
| [codex-client-compatibility-test.mjs](../tools/native/codex-client-compatibility-test.mjs) | 后端默认入口 | TR05、MO01、CL01、CL02 |
| [codex-models-renderer-test.mjs](../tools/native/codex-models-renderer-test.mjs) | 后端默认入口 | MO04、CL01、CL03、CL04、CL05、CL07、CL08 |
| [metadata-test.mjs](../tools/native/metadata-test.mjs) | 后端默认入口 | MO06 |
| [model-metadata-consumption-test.mjs](../tools/native/model-metadata-consumption-test.mjs) | 后端默认入口 | MO01、MO03、CL01 |
| [models-dev-unification-test.mjs](../tools/native/models-dev-unification-test.mjs) | 后端默认入口 | CO02、CO04、MO01、MO06 |
| [official-catalog-test.mjs](../tools/native/official-catalog-test.mjs) | 后端默认入口 | MO01 |
| [protocol-test.mjs](../tools/native/protocol-test.mjs) | 后端默认入口 | MO01、MO02、MO03、MO06 |
| [provider-catalog-test.mjs](../tools/native/provider-catalog-test.mjs) | 后端默认入口 | MO01、MO02、MO03、MO04、MO06 |
| [provider-dialog-renderer-test.mjs](../tools/native/provider-dialog-renderer-test.mjs) | 后端默认入口 | MO04 |
| [provider-presets-test.mjs](../tools/native/provider-presets-test.mjs) | 后端默认入口 | MO01 |
| [provider-validation-test.mjs](../tools/native/provider-validation-test.mjs) | 后端默认入口 | MO01、MO02、MO03、MO06 |
| [reasoning-test.mjs](../tools/native/reasoning-test.mjs) | 后端默认入口 | MO02 |
| [routing-consumption-test.mjs](../tools/native/routing-consumption-test.mjs) | 后端默认入口 | TR01、TR02、TR07、MO03、MO06、CL01、CL02、CL05、CL06、LF03 |
| [codex-client-contract-test.mjs](../tools/shared-core/codex-client-contract-test.mjs) | 独立专题入口 | MO01 |

## CL 客户端配置与续接

功能编号：`CL01`、`CL02`、`CL03`、`CL04`、`CL05`、`CL06`、`CL07`、`CL08`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [claude-config-path-test.mjs](../tools/native/claude-config-path-test.mjs) | 后端默认入口 | CL07 |
| [client-config-merge-test.mjs](../tools/native/client-config-merge-test.mjs) | 后端默认入口 | CL01、CL03、CL04、CL05、CL07、CL08 |
| [client-management-test.mjs](../tools/native/client-management-test.mjs) | 后端默认入口 | CL07 |
| [client-models-renderer-test.mjs](../tools/native/client-models-renderer-test.mjs) | 后端默认入口 | MO04、CL01、CL03、CL04、CL05、CL07、CL08 |
| [client-trace-defaults-test.mjs](../tools/native/client-trace-defaults-test.mjs) | 后端默认入口 | TR01、CL01 |
| [codex-client-compatibility-test.mjs](../tools/native/codex-client-compatibility-test.mjs) | 后端默认入口 | TR05、MO01、CL01、CL02 |
| [codex-models-renderer-test.mjs](../tools/native/codex-models-renderer-test.mjs) | 后端默认入口 | MO04、CL01、CL03、CL04、CL05、CL07、CL08 |
| [desktop-lifecycle-test.mjs](../tools/native/desktop-lifecycle-test.mjs) | 后端默认入口 | CL06、LF02、LF03、LF04、LF05 |
| [desktop-model-routing-test.mjs](../tools/native/desktop-model-routing-test.mjs) | 后端默认入口 | CL01、CL03、CL04、CL05、CL07、CL08 |
| [expanded-clients-test.mjs](../tools/native/expanded-clients-test.mjs) | 后端默认入口 | CL07 |
| [gateway-clients-test.mjs](../tools/native/gateway-clients-test.mjs) | 条件入口 | CL07 |
| [gateway-forwarding-test.mjs](../tools/native/gateway-forwarding-test.mjs) | 后端默认入口 | CL07 |
| [installed-clients-test.mjs](../tools/native/installed-clients-test.mjs) | 条件入口 | CL01、CL08 |
| [legacy-direct-test.mjs](../tools/native/legacy-direct-test.mjs) | 后端默认入口 | CL06 |
| [legacy-helper-test.mjs](../tools/native/legacy-helper-test.mjs) | 后端默认入口 | CL06 |
| [legacy-recovery-test.mjs](../tools/native/legacy-recovery-test.mjs) | 后端默认入口 | CL06 |
| [model-metadata-consumption-test.mjs](../tools/native/model-metadata-consumption-test.mjs) | 后端默认入口 | MO01、MO03、CL01 |
| [official-test.mjs](../tools/native/official-test.mjs) | 后端默认入口 | CL04 |
| [portability-test.mjs](../tools/native/portability-test.mjs) | 后端默认入口 | TR01、TR02、TR03、TR04、TR05、TR06、TR07、TR09、CL01、CL02、CL03、CL04、CL05、CL07、CL08 |
| [regressions.mjs](../tools/native/regressions.mjs) | 后端默认入口 | CL01 |
| [routing-consumption-test.mjs](../tools/native/routing-consumption-test.mjs) | 后端默认入口 | TR01、TR02、TR07、MO03、MO06、CL01、CL02、CL05、CL06、LF03 |
| [universal-gateway-test.mjs](../tools/native/universal-gateway-test.mjs) | 后端默认入口 | CL07 |

## SE 设置、配置读写与 Trace 存储

功能编号：`SE01`、`SE02`、`SE03`、`SE04`、`SE05`、`SE06`、`SE07`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [config-import-compatibility-test.mjs](../tools/native/config-import-compatibility-test.mjs) | 后端默认入口 | SE01 |
| [config-import-test.mjs](../tools/native/config-import-test.mjs) | 后端默认入口 | SE01 |
| [configuration-removal-test.mjs](../tools/native/configuration-removal-test.mjs) | 后端默认入口 | SE01 |
| [directory-lifecycle-test.mjs](../tools/native/directory-lifecycle-test.mjs) | 后端默认入口 | SE02、SE03、SE07 |
| [preferences-test.mjs](../tools/native/preferences-test.mjs) | 后端默认入口 | SE02、SE03、SE04、AC01、UI04、LF03 |
| [provider-identity-test.mjs](../tools/native/provider-identity-test.mjs) | 后端默认入口 | SE01 |
| [settings-write-test.mjs](../tools/native/settings-write-test.mjs) | 后端默认入口 | SE01、SE02、SE03 |
| [trace-index-repair-test.mjs](../tools/native/trace-index-repair-test.mjs) | 后端默认入口 | SE02、SE03、SE06 |
| [trace-usage-only-test.mjs](../tools/native/trace-usage-only-test.mjs) | 后端默认入口 | SE04、SE05 |
| [trace-writer-test.mjs](../tools/native/trace-writer-test.mjs) | 后端默认入口 | SE02、SE03、SE04、SE05 |
| [run-bridge-order-regressions.mjs](../tools/tests/run-bridge-order-regressions.mjs) | test:built 入口 | SE02 |

## AC 账号、凭据与额度

功能编号：`AC01`、`AC02`、`AC03`、`AC04`、`AC06`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [chatgpt-usage-test.mjs](../tools/native/chatgpt-usage-test.mjs) | 后端默认入口 | AC03 |
| [claude-secure-store-test.mjs](../tools/native/claude-secure-store-test.mjs) | 后端默认入口 | AC01 |
| [claude-subscriptions-test.mjs](../tools/native/claude-subscriptions-test.mjs) | 后端默认入口 | AC02 |
| [cli-home-lifecycle-test.mjs](../tools/native/cli-home-lifecycle-test.mjs) | 后端默认入口 | AC06 |
| [copilot-subscriptions-test.mjs](../tools/native/copilot-subscriptions-test.mjs) | 后端默认入口 | AC02 |
| [credential-os-test.mjs](../tools/native/credential-os-test.mjs) | 后端默认入口 | AC01 |
| [credential-private-files-test.mjs](../tools/native/credential-private-files-test.mjs) | 后端默认入口 | AC01、AC02、AC06 |
| [credential-validation-test.mjs](../tools/native/credential-validation-test.mjs) | 后端默认入口 | AC02、AC06 |
| [credential-vault-test.mjs](../tools/native/credential-vault-test.mjs) | 后端默认入口 | AC01 |
| [cursor-subscriptions-test.mjs](../tools/native/cursor-subscriptions-test.mjs) | 后端默认入口 | AC02 |
| [grok-secure-store-test.mjs](../tools/native/grok-secure-store-test.mjs) | 后端默认入口 | AC01 |
| [grok-subscriptions-test.mjs](../tools/native/grok-subscriptions-test.mjs) | 后端默认入口 | AC02 |
| [official-accounts-test.mjs](../tools/native/official-accounts-test.mjs) | 后端默认入口 | AC02、AC06 |
| [official-chatgpt-renderer-test.mjs](../tools/native/official-chatgpt-renderer-test.mjs) | 后端默认入口 | AC02 |
| [official-chatgpt-test.mjs](../tools/native/official-chatgpt-test.mjs) | 后端默认入口 | AC02 |
| [official-private-files-test.mjs](../tools/native/official-private-files-test.mjs) | 后端默认入口 | AC01 |
| [preferences-test.mjs](../tools/native/preferences-test.mjs) | 后端默认入口 | SE02、SE03、SE04、AC01、UI04、LF03 |
| [subscription-import-private-files-test.mjs](../tools/native/subscription-import-private-files-test.mjs) | 后端默认入口 | AC02 |
| [subscription-import-test.mjs](../tools/native/subscription-import-test.mjs) | 后端默认入口 | AC02 |
| [subscription-routing-test.mjs](../tools/native/subscription-routing-test.mjs) | 后端默认入口 | AC02、AC04、AC06、SW01、SW02、SW03 |
| [subscription-usage-test.mjs](../tools/native/subscription-usage-test.mjs) | 后端默认入口 | AC02、AC03、AC06 |
| [subscriptions-test.mjs](../tools/native/subscriptions-test.mjs) | 后端默认入口 | AC02 |

## HI 客户端会话历史管理

功能编号：`HI01`、`HI02`、`HI03`、`HI04`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [legacy-codex-test.mjs](../tools/native/legacy-codex-test.mjs) | 后端默认入口 | HI01 |
| [run-history-confirm-regressions.mjs](../tools/tests/run-history-confirm-regressions.mjs) | test:built 入口 | HI03 |

## UI 首次设置与共用界面

功能编号：`UI01`、`UI02`、`UI03`、`UI04`、`UI05`、`UI06`、`UI07`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [bridge-renderer-lifecycle-test.mjs](../tools/native/bridge-renderer-lifecycle-test.mjs) | 后端默认入口 | UI06 |
| [client-installations-renderer-test.mjs](../tools/native/client-installations-renderer-test.mjs) | 后端默认入口 | UI02 |
| [configuration-state-renderer-test.mjs](../tools/native/configuration-state-renderer-test.mjs) | 后端默认入口 | UI02 |
| [language-renderer-test.mjs](../tools/native/language-renderer-test.mjs) | 后端默认入口 | UI02、UI03、UI05、UI07 |
| [language-test.mjs](../tools/native/language-test.mjs) | 后端默认入口 | UI07 |
| [onboarding-renderer-test.mjs](../tools/native/onboarding-renderer-test.mjs) | 后端默认入口 | UI01、UI02、UI03、UI05 |
| [preferences-test.mjs](../tools/native/preferences-test.mjs) | 后端默认入口 | SE02、SE03、SE04、AC01、UI04、LF03 |
| [shared-fonts-test.mjs](../tools/native/shared-fonts-test.mjs) | 独立专题入口 | UI07 |
| [subscription-import-renderer-test.mjs](../tools/native/subscription-import-renderer-test.mjs) | 后端默认入口 | UI01 |
| [theme-test.mjs](../tools/native/theme-test.mjs) | 独立专题入口 | UI04 |
| [toast-layer-renderer-test.mjs](../tools/native/toast-layer-renderer-test.mjs) | 独立专题入口 | UI02、UI03、UI06 |
| [toast-renderer-test.mjs](../tools/native/toast-renderer-test.mjs) | 后端默认入口 | UI02、UI03、UI05、UI06 |
| [trace-clients-renderer-test.mjs](../tools/native/trace-clients-renderer-test.mjs) | 独立专题入口 | CO06、UI02、UI03、UI05 |
| [run-theme-regressions.mjs](../tools/tests/run-theme-regressions.mjs) | test:built 入口 | UI04 |
| [run-trace-notice-regressions.mjs](../tools/tests/run-trace-notice-regressions.mjs) | test:built 入口 | UI06 |

## LF 生命周期、托盘与恢复

功能编号：`LF01`、`LF02`、`LF03`、`LF04`、`LF05`、`LF06`、`LF07`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [application-reset-private-files-test.mjs](../tools/native/application-reset-private-files-test.mjs) | 后端默认入口 | LF06 |
| [application-reset-test.mjs](../tools/native/application-reset-test.mjs) | 后端默认入口 | LF02、LF04、LF05、LF06 |
| [application-reset-ui-test.mjs](../tools/native/application-reset-ui-test.mjs) | 独立专题入口 | LF06 |
| [desktop-lifecycle-test.mjs](../tools/native/desktop-lifecycle-test.mjs) | 后端默认入口 | CL06、LF02、LF03、LF04、LF05 |
| [preferences-test.mjs](../tools/native/preferences-test.mjs) | 后端默认入口 | SE02、SE03、SE04、AC01、UI04、LF03 |
| [routing-consumption-test.mjs](../tools/native/routing-consumption-test.mjs) | 后端默认入口 | TR01、TR02、TR07、MO03、MO06、CL01、CL02、CL05、CL06、LF03 |
| [toggle-renderer-test.mjs](../tools/native/toggle-renderer-test.mjs) | 后端默认入口 | LF01 |
| [tool-wait-test.mjs](../tools/native/tool-wait-test.mjs) | 后端默认入口 | TR06、LF01、LF02、LF04、LF05 |
| [trace-stop-admission-test.mjs](../tools/native/trace-stop-admission-test.mjs) | 后端默认入口 | LF01、LF02、LF04、LF05 |
| [window-lifecycle-test.mjs](../tools/native/window-lifecycle-test.mjs) | 独立专题入口 | LF02、LF04、LF05、LF07 |

## RE 构建、安装、更新与交付

功能编号：`RE01`、`RE02`、`RE03`、`RE04`、`RE05`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [portable-update-test.mjs](../tools/native/portable-update-test.mjs) | 后端默认入口 | RE02、RE03、RE04、RE05 |
| [public-boundary-test.mjs](../tools/native/public-boundary-test.mjs) | 后端默认入口 | RE01 |
| [source-fingerprint-test.mjs](../tools/native/source-fingerprint-test.mjs) | 后端默认入口 | RE01、RE02、RE03、RE04 |
| [update-test.mjs](../tools/native/update-test.mjs) | 后端默认入口 | RE02、RE03、RE04、RE05 |
| [release-manifest-test.mjs](../tools/tests/release-manifest-test.mjs) | test:built 入口 | RE02 |

## SW 额度耗尽自动服务切换

功能编号：`SW01`、`SW02`、`SW03`、`SW04`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [enhancements-choices-renderer-test.mjs](../tools/native/enhancements-choices-renderer-test.mjs) | 后端默认入口 | SW01 |
| [service-switching-pool-test.mjs](../tools/native/service-switching-pool-test.mjs) | 后端默认入口 | SW01、SW02、SW03 |
| [service-switching-test.mjs](../tools/native/service-switching-test.mjs) | 后端默认入口 | SW01、SW02、SW03、SW04 |
| [subscription-routing-test.mjs](../tools/native/subscription-routing-test.mjs) | 后端默认入口 | AC02、AC04、AC06、SW01、SW02、SW03 |

## DG 诊断与修复中心

功能编号：`DG01`、`DG02`、`DG03`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [application-repair-test.mjs](../tools/native/application-repair-test.mjs) | 后端默认入口 | DG01、DG02、DG03 |
| [client-repair-test.mjs](../tools/native/client-repair-test.mjs) | 后端默认入口 | DG01、DG02、DG03 |
| [upstream-diagnostics-test.mjs](../tools/native/upstream-diagnostics-test.mjs) | 后端默认入口 | DG01、DG02、DG03 |

## WE 官网与内嵌应用预览

功能编号：`WE01`、`WE02`、`WE03`。

| 脚本 | 执行入口 | 关联编号 |
| --- | --- | --- |
| [site-browser-test.mjs](../tools/site/site-browser-test.mjs) | 独立专题入口 | WE01、WE02、WE03 |

## 尚未关联稳定编号的门禁脚本

这些脚本已列入命令，但功能目录未引用。
新增或调整断言时，应补充对应编号。
本表不会自动创建验收项目或通过结果。

| 脚本 | 执行入口 |
| --- | --- |
| [public-binary-boundary-test.mjs](../tools/native/public-binary-boundary-test.mjs) | 后端默认入口 |
| [reasoning-chat-providers-test.mjs](../tools/native/reasoning-chat-providers-test.mjs) | 后端默认入口 |
| [trace-compaction-test.mjs](../tools/native/trace-compaction-test.mjs) | 后端默认入口 |
| [public-history-test.mjs](../tools/tests/public-history-test.mjs) | test:built 入口 |
