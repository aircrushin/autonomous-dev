# ADR 0016：Goal-level controller leader election

需要多个 controller 进程共同服务时，可通过 `leaderElection` 为 Goal 取得一个持久化 goal-level lease。只有 lease owner 进入调度主循环；竞争失败的 controller 返回当前 READY/PENDING/RUNNING 工作项为 `skipped`，不改变任何工作项状态。leader 持有期间由 heartbeat 续租；heartbeat 或轮次前校验失败会触发 leader fence，停止后续调度。正常退出释放 lease，后续 controller 可以接管。

工作项 lease 仍是最终写入 fencing；goal-level lease 负责减少同一 Goal 的重复调度。集成测试覆盖两个独立 Node 进程竞争同一 SQLite Goal leader。该机制不声称跨 Goal 的公平性，也不替代工作项级并发去重。
