# ADR 0029：Phase 2 中断 Attempt 的恢复编排

## 决策

控制器在调度前通过 `recoverGoalAttempts` 对当前 Goal 的未结束 Attempt 做一次持久化对账。没有有效工作项租约的 Attempt 由 Store 标记为已恢复，仍处于 `RUNNING` 的工作项按 `RUNNING → FAILED → READY` 重新排队。恢复报告同时为下一轮生成 `attemptCount + 1` 和 `RUNNER_ERROR` 上下文。

## 原因

进程重启后不能把中断执行误当成全新首轮，否则 Agent 看不到已经消耗的执行轮次，也无法区分恢复自执行器崩溃。已结束 Attempt 保持不可变，不会被重复对账。

## 边界

该编排只负责持久状态和调度上下文；它不重放旧命令、不绕过租约，也不替代既有失败指纹和有限重试策略。真实跨机进程管理仍不在本地闭环内。
