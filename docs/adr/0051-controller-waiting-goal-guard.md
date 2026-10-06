# ADR 0051：Controller 不调度不可执行 Goal

`runControllerRound` 与 `runControllerLoop` 入口拒绝 `WAITING_HUMAN`、`WAITING_EXTERNAL`、`PAUSED_BUDGET`、`VERIFYING`、`DELIVERING`、`SUCCEEDED`、`CLOSED_UNACHIEVABLE` Goal。loop 对这些状态返回 deferred/skipped，不调用 configure/Agent，也不修改 WorkItem；DRAFT/PLANNING/RUNNING 的 bootstrap 语义保持不变，FAILED/RECOVERING 保留现有恢复与 retry 路径。

测试覆盖 WAITING_HUMAN/WAITING_EXTERNAL 的 loop 与 direct round 防线、Agent 调用数为零、PENDING WorkItem/Goal 状态保持不变，以及既有恢复、人工和交付回归。
