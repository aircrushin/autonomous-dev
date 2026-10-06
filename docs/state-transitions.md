# 状态迁移表

| 实体 | 合法迁移 | 关键守卫 |
|---|---|---|
| Goal | `DRAFT→PLANNING→RUNNING→VERIFYING→DELIVERING→SUCCEEDED` | 目标/契约存在；每次迁移事务化 |
| Goal | `RUNNING→WAITING_EXTERNAL/WAITING_HUMAN/PAUSED_BUDGET/FAILED/RECOVERING` | 记录原因和事件 |
| Goal | `WAITING_*→RUNNING`, `RECOVERING→RUNNING/FAILED`, `FAILED→RUNNING/CLOSED_UNACHIEVABLE` | 外部结果、授权或诊断证据已记录 |
| WorkItem | `PENDING→READY→RUNNING→SUCCEEDED/FAILED/BLOCKED`；未满足依赖时允许 `READY→BLOCKED` | 依赖满足；同一租约只能一个写入者 |

`SUCCEEDED` 和 `CLOSED_UNACHIEVABLE` 是 Goal 终态。状态变化与事件写入同一 SQLite 事务；非法边、缺失实体和失效租约拒绝写入。重启先读取快照，事件日志用于审计和恢复诊断。
