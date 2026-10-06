# ADR 0057：验证器 mandatory quality profile

验证器增加显式 `qualityProfile: 'mandatory'`。启用该 profile 时，调用方必须提供 `quality-lint` 与 `quality-secrets` 两个检查，否则在执行前拒绝；推荐使用 `mandatoryQualityChecks(workspace)` 生成检查定义。脚本命令把候选 workspace 作为参数传入，因此扫描目标来自候选工作区，不依赖控制器当前目录。

默认旧调用保持兼容；控制器通过 `qualityProfile` 选择强制门禁，既有自定义检查和注入执行器语义不变。质量检查的 FAIL/ERROR 仍由既有 gate 决定，不接受 Agent 自报完成。
