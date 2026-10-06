# ADR 0014：按失败分类切换恢复策略

`runControllerLoop` 为每个工作项维护本轮恢复上下文，包含尝试次数、`FailureKind` 和当前策略。Gate 未放行时，控制器根据 verifier 状态与 stderr 分类失败，并通过可选的 `strategyFor` 选择下一轮策略；`configure` 和 `agentFor` 会收到该上下文。策略同时进入 retry fingerprint，因此切换策略不会被错误地判定为重复无进展。

默认行为保持兼容：未提供 `strategyFor` 时继续使用 `recovery.strategy`，已有的一参数 `configure`/`agentFor` 也无需修改。集成测试覆盖首轮测试失败、切换到 `repair-tests`、第二轮通过的完整滚动路径。
