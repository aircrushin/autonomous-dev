# ADR 0053：RECOVERING Goal 的恢复编排

`runControllerLoop` 对 `RECOVERING` 不再直接 skipped，而是进入 owned recovery 分支：先调用 `recoverGoalAttempts`；存在可恢复 Attempt 时，将其对账并把 Goal 显式迁移 `RECOVERING→RUNNING`，再调度 READY WorkItems。没有可恢复 Attempt 时保持 `RECOVERING`、返回 skipped，不盲目执行。`runControllerRound` 仍拒绝直接执行 RECOVERING，FAILED 继续短路。

集成测试覆盖无 Attempt 阻断、Attempt 结束后的重启恢复、WorkItem READY→RUNNING→SUCCEEDED、Goal 回到 RUNNING/VERIFYING 及 Agent 不重复执行。
