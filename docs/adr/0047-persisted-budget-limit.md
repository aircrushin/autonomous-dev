# ADR 0047：预算预留使用持久化上限

`reserveBudget` 在事务内读取 Goal 的 `budget.limit`。当持久化 limit 为 finite 且非负时，调用方必须传入相同 limit，预算耗尽判断使用该持久化值；不一致或超额请求回滚且不写预算/event。未配置 limit 的旧 Goal 继续使用调用方显式 limit。`PAUSED_BUDGET` 仍读取同一 `budget_usage.reserved` 与 Goal limit 事实。

测试覆盖 limit mismatch、较大 limit 绕过、正确 limit、无配置兼容、失败无脏写及预算耗尽后的暂停事实。
