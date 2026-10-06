# ADR 0034：CLI 使用显式计划 JSON

`devctl goal:create-plan <goal-id> <intent> <plan.json>` 只接收用户或外部 planner 已生成的 JSON，调用确定性 `validateGoalPlan` 和 `Store.createGoalWithPlan`。非法 JSON、缺文件、重复 Goal 和缺少 plan 都以非零退出且不产生半成品。CLI 不内置模型推理、网络调用或凭据。
