# ADR 0043：Goal 预算暂停与不可达关闭事实守卫

`PAUSED_BUDGET` 只有在 Goal 配置了有效 `budget.limit` 且持久化 `budget_usage.reserved` 已达到该上限时允许；空 Goal 或未耗尽预算不能伪造预算暂停。`CLOSED_UNACHIEVABLE` 只允许从 `FAILED` 进入，并要求 transition context 同时包含非空 `reason` 与可审计的非空 diagnostic 对象或引用。普通和 lease transition 共用同一事实检查，失败事务不写状态或事件；通过时 context 按既有 Goal 状态事件持久化。

测试覆盖空事实拒绝、预算预留耗尽后允许、FAILED+diagnostic 允许，以及 lease 入口的拒绝/允许。
