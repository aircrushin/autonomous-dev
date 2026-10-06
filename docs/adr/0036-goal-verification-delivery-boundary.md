# ADR 0036：多 WorkItem 的验证与交付边界

控制器只有在 Goal 下所有 WorkItem 均为 `SUCCEEDED` 或 `BLOCKED` 时才把 `RUNNING` 推进为 `VERIFYING`。Goal 进入 `VERIFYING` 或恢复 `DELIVERING` 前，交付编排再次检查同一终态条件；存在 `PENDING`、`READY`、`RUNNING` 或 `FAILED` 时拒绝 provider 调用。单 WorkItem 路径保持原有行为。
