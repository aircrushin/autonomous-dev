# ADR 0022：Fair scheduler 接入 controller pool

`runControllerPool(store, inputs, options)` 以现有 `runControllerLoop` 为每个 Goal 的 step，每次 step 固定执行一轮（`maxRounds: 1`、单 Goal 内并发为 1），再交给 `runFairGoalScheduler` 轮转。这样每轮仍使用原有工作项 lease、Goal leader、retry、verifier 和 Evidence 持久化。

单轮退出时，尚未轮到的 PENDING 工作项保持 PENDING；只有依赖确实不可满足的 PENDING 项才转为 BLOCKED。Goal pool 结果聚合每个 Goal 最近一轮结果，并把未完成 Goal 返回为 skipped，支持外层 `maxTurns` 做长期运行边界。

集成测试覆盖两个 Goal 各两个工作项的 A/B 轮转，以及 8 个 Goal×3 个工作项的 bounded soak、Attempt 去重和最终 SUCCEEDED。该 pool 尚未接入 CLI 常驻服务，也不替代跨机器 leader/worker 部署。
