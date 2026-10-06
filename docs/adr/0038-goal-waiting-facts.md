# ADR 0038：Goal 等待与恢复状态事实守卫

`transitionGoal` 和带 lease 的同一入口接受可选 transition context，并将其保留在状态事件中。进入 `WAITING_HUMAN` 必须已有 OPEN HumanRequest，进入 `WAITING_EXTERNAL` 必须有 PENDING/UNKNOWN Operation，进入 `RECOVERING` 必须有未结束且没有有效 lease 的 Attempt；对应等待状态恢复到 `RUNNING` 时必须已清除阻塞事实。失败在同一事务内拒绝，不写状态或事件。
