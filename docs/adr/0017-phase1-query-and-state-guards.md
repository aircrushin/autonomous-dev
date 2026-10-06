# ADR 0017：Phase 1 查询 API 与终态写入守卫

控制器恢复和 CLI 查询需要稳定的只读集合接口，因此 `Store` 提供 `listGoals()` 与可按 `workItemId` 过滤的 `listAttempts()`，返回与单项查询相同的反序列化契约。Goal 事件查询保留所有关联 Evidence 的历史记录；`listEvidenceForGoal()` 才负责只返回当前契约且未过期的有效 Evidence。

持久化层拒绝向 `SUCCEEDED` 或 `CLOSED_UNACHIEVABLE` 的 Goal 新建工作项或人工请求，也拒绝为 `SUCCEEDED` 或 `BLOCKED` 的 WorkItem 新建 Attempt；`SUCCEEDED` 或 `FAILED` 的 Operation 不能再被 push、外部或 merge 回执覆盖。状态迁移仍由 `assertGoalTransition` 与 `assertWorkItemTransition` 统一控制；这些守卫只补充实体创建边界，不改变恢复旧 Attempt 的路径。

单元测试覆盖集合查询、终态写入拒绝、历史 Evidence 查询和已有事务回滚行为。
