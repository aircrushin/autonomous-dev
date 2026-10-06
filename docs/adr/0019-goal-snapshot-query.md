# ADR 0019：统一 GoalSnapshot 复合查询

控制器 CLI 和 dashboard 需要读取同一组 Goal 关联状态。`Store.getGoalSnapshot(goalId)` 统一返回 Goal、WorkItem、Attempt、当前有效 Evidence、HumanRequest、Operation、完整事件历史和预算使用量；不存在的 Goal 返回 `undefined`。

当前有效 Evidence 仍遵循契约版本和过期时间过滤，事件历史仍保留旧证据。dashboard 使用该快照生成展示数据，避免入口各自拼接导致范围漂移。该查询是只读组合，不改变状态或租约。
