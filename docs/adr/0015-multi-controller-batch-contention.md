# ADR 0015：多 controller 同批次调度的 lease contention

多个 controller 可以从同一 SQLite 读取同一批 READY 工作项并发调度。每个工作项的 `runControllerRound` 仍先取得持久化 lease；竞争失败的 controller 将该项 deferred，不改变对方的状态。成功的 controller 完成该项后，另一 controller 不会重复调用 Agent。

集成测试覆盖两个共享同一数据库的 controller、四个无依赖工作项、并发 Agent 运行、lease contention 和最终全部 `SUCCEEDED`。这证明同批次的执行去重，不等同于完整的 leader election 或公平性保证。
