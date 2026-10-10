# 客户端管理验证，2026-10-11

源码 `36f8f0f`，开发分支 `codex/client-management-20261011`，基于新手引导 `2c228d7`。原 main 工作树未改变，未安装或发布。

补回具有手动 Gateway 连接说明的独立客户端模型管理入口，保留自动配置与手动连接区别、Pi/oh-my-pi 分离和 Desktop/CLI 归并。修复迟到配置/目录/状态覆盖、失败丢选择与导航回退；WorkBuddy Desktop 使用官方 `https://www.workbuddy.cn/`。中文、空格及同名配置保留独立 ID，不按显示名称覆盖。

## 已通过

- 编译、旧行为、上游回归、公开边界、GitHub 工作流检查。
- Rust 11 单元，27 原生后端套件入口成功返回，1 项物理 Windows 更新测试跳过。
- 实际 React/Base UI 选择框 8 项合同：保存失败保留选择及重试、旧回读/目录丢弃、导航和迟到全局状态保护。
- 官方 Pi 1.1.0、OpenCode 1.18.35 实际读取生成文件，分别完成 5、10 次本地请求。覆盖 Provider/模型切换、Chat→Responses、停止后直连、重启选择和外部非负责字段保留。OpenCode 的原 small_model 辅助请求保持原配置。

首次原生回归发现测试硬编码旧 release 程序、缺少 jsdom 和旧名称限制；修复后全部重跑通过。测试依赖仅开发使用，正式原生包不携带 Node。

## 边界与续验

上述请求使用临时 HOME、合成凭据和本地上游，不能作为官方平台授权、真实账单或其他客户端二进制已通过的证明。每次运行 Pi/OpenCode CLI 都重新读取配置，不宣称运行中的交互会话自动重载。

屏幕锁定，新增原生 WebView 场景及 Finder 操作尚未验收。Windows 和其他客户端的实际安装/运行仍需各自验证；只有官方下载入口的产品不宣称自动配置或代理支持。新增独立 CLI 接口已有回归，后续按真实适配能力扩展。

重复验证：设置 `XWX_INSTALLED_PI` 为官方 Pi JavaScript 入口、`XWX_INSTALLED_OPENCODE` 为官方可执行文件，运行 `node tools/native/gateway-clients-test.mjs`；可任选一个或同时验证。完整原生入口会自动加入已明确指定的客户端。运行前构建当前测试程序，或显式设置 `XWX_NATIVE_TEST_BINARY`，不沿用旧包。
