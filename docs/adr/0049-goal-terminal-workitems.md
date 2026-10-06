# ADR 0049：Goal 验证与交付的 WorkItem 终态守卫

Goal 转入 `VERIFYING` 或 `DELIVERING` 时，若存在 WorkItems，所有项必须为 `SUCCEEDED` 或 `BLOCKED`；`PENDING`、`READY`、`RUNNING`、`FAILED` 均拒绝。空 WorkItem 集合保留现有兼容路径。普通和带 lease 的 Goal transition 共用事务内事实检查，失败不写状态或事件。交付流水线继续在 provider 调用前依赖该边界。

测试覆盖普通/lease 拒绝、成功与 BLOCKED 允许、空集合兼容，以及 delivery pipeline 回归。
