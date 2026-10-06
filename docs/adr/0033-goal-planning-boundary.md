# ADR 0033：需求结构化与 WorkItem 规划边界

`GoalPlanner` 负责将用户意图转换为带版本的验收 requirements/checks 和 WorkItem 依赖图；控制面通过 `validateGoalPlan` 做确定性校验，Store 只在一个事务中写入 Goal 与 WorkItems，不负责模型推理。无效规划或 planner 失败不得产生半成品状态。旧 `createGoal` API 保持兼容。
