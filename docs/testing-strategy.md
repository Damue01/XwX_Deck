# 测试执行方式

当前要求、测试入口和执行结果分别维护。
功能编号见 [核心清单](core-functional-acceptance-checklist.md)。
开发顺序见 [开发流程](development-testing-workflow.md)。
Trace 的续聊、停止、工具与记录见 [状态矩阵](maintenance/trace-state-acceptance.md)。
实际命令归属见 [脚本映射](test-coverage-map.md)。

## 证据层级

| 标记 | 验证范围 | 需要记录 |
| --- | --- | --- |
| P | 单测、合成服务、实际组件和浏览器检查 | 源码、断言、输入和结果 |
| R | 真实授权、正式上游和实际 CLI | 客户端版本、精确型号、线程与实际路由 |
| U | 实际 Deck 或客户端界面 | 包哈希、操作、回读、窗口和对应请求 |
| H | 用户完成的密码、登录或系统授权 | 具体授权与后续独立检查 |

真实 CLI 可以由脚本驱动，仍属于 R。
原生界面使用合成上游时标为 U+P。
RPC、预览或登录成功不能代替真实链路。
物理操作记录为 U，系统授权另标 H。

## 常用命令

```sh
npm run check:docs
npm run check:test-plan
node tools/checks/report-test-coverage.mjs --check
npm run check:runtime-boundary
npm run check:public-boundary
npm run check:quality
```

工程门禁不包含全部专题脚本。
按入口映射补跑布局、阅读、Toast 和窗口。
先编译当前源码，再指定对应测试二进制。
默认后端串行执行，使用隔离根和本地服务。
真实授权与付费请求不自动加入合成回归。

## 最终检查

开启 Trace 后新建测试对话。
切服务后继续同一线程，核对上下文和上游。
停止后检查直连、受管账本与代理监听。
界面检查要核对落盘和实际执行结果。
按 [执行模板](test-run-template.json) 分子场景记录。
首次失败、修复和复测各自保留。
平台跳过、受阻与未验不得改为通过。

XwX Deck 没有旧发行版本兼容需求。
不增加其他产品的数据或更新源迁移。
正常重启与未来原生更新仍要保留本版数据。
测试不修改正常客户端、凭据或历史。
本地构建和源码推送不授权安装或发布。
