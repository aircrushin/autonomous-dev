# ADR 0040：验证阶段 lease fencing 的 Attempt 可恢复性

## 背景

控制器此前在 Agent 返回后立即结束 Attempt，再执行验证。验证期间 lease 被回收时，后续 Evidence/WorkItem 写入会被 fencing 拒绝，导致 WorkItem 停留 `RUNNING` 且没有未结束 Attempt，`recoverGoalAttempts` 无法接管。

## 决策

Attempt 在 Agent 成功返回后保持未结束，直到验证完成并且 WorkItem 状态提交成功前才结束。成功和 Gate 失败路径通过 `finishAttemptAndTransitionWorkItemWithLeaseAndGoalVersions` 在同一 SQLite transaction 内原子结束 Attempt 并写入 `SUCCEEDED`/`FAILED`，消除进程崩溃造成的“Attempt 已结束而 WorkItem 仍 RUNNING”窗口。验证、Evidence 或 lease fencing 在此之前失败时，Attempt 保持未结束；恢复编排可据此将 `RUNNING` 工作项转为 `READY` 并由后续 controller 接管。

Agent 异常仍保留未结束 Attempt 并将工作项标记失败；普通成功和 Gate failure 的既有语义保持不变。

## 验证

集成测试注入验证执行期间主动 revoke lease，确认失败后存在可恢复 Attempt、`recoverGoalAttempts` 可重排工作项，后续 controller 可完成；controller-loop focused 21/21。
