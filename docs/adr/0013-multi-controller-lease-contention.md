# ADR 0013：多 controller 的 lease contention 处理

`runControllerLoop` 遇到已被其他 owner 持有的工作项 lease 时，将该项放入 `skipped` 并等待下一轮，不把租约竞争记录为业务失败，也不修改对方持有的工作项状态。真正的写入资格仍由 `runControllerRound` 的持久化 lease fencing 决定。

当前测试覆盖已有 lease 的 contention 行为；跨进程 lease fencing 另由 Phase 4 SQLite 子进程测试覆盖。完整的多 controller 领导者选举、同一批次的端到端并发调度和公平性仍未实现。
