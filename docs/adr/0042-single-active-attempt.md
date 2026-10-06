# ADR 0042：同一 WorkItem 单一 active Attempt

同一 WorkItem 在恢复和并发 controller 场景下只能有一个 `ended_at IS NULL` Attempt。`startAttempt` 与未提供 `endedAt` 的 `recordAttempt` 在各自已有 SQLite transaction 中查询 active Attempt，发现已有记录即拒绝；事务回滚，因此首个 Attempt、WorkItem 状态和事件不变。带 `endedAt` 的历史记录仍可写入，已结束 Attempt 不阻塞后续重试。文件 SQLite 的事务锁提供跨 Store 竞争下的同一约束。

单元测试覆盖重复 start、active record、结束后重试、历史记录及两个 Store 竞争。
