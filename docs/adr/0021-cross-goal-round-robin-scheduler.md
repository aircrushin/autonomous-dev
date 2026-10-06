# ADR 0021：跨 Goal 有界 round-robin 调度

Phase 4 增加 `runFairGoalScheduler` 作为跨 Goal 调度基础。每个活跃 Goal 的调用方 step 最多在一轮中执行一次；未完成的 Goal 回到队尾，直到完成、失败或达到 `maxTurns`。`maxConcurrency` 只控制同一轮并发 step 数，不改变 lease、状态迁移或验证权限。

该原语不替代 `runControllerLoop` 的工作项依赖调度，也不自动取得 Goal leader lease；调用方必须在 step 内使用现有 controller API。测试证明三个长期 Goal 按 A/B/C 轮转、并在有界轮数后返回 skipped，避免单 Goal 无限占用调度机会。
