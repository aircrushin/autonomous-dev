# ADR 0039：Pool worker 聚合终态失败

## 背景

`runControllerLoop` 会把 Agent 异常或无恢复 Gate 失败持久化为 `WorkItem=FAILED`，但一轮 pool 调度本身不会抛出 Goal 级异常。此前 `runControllerPoolWorker` 继续把所有 `FAILED` 当作活跃工作，最终以 `IDLE_LIMIT` 返回并把 Goal 放入 `skipped`，丢失了失败事实。

## 决策

worker 每轮在调度前后读取持久化 WorkItem 与 `retry_state`：当存在 `FAILED`、没有 `retry_state.decision='RETRY'`，且不存在 `PENDING/READY/RUNNING` 时，将 Goal 聚合到 `failed`，不计入 `skipped`，并以 `stopReason='FAILED'` 终止本次 worker。带有 `RETRY` 决策的失败保留为可恢复状态，继续由 controller loop 重排并轮询。

该判断只消费已有持久化状态，不新增恢复策略，也不改变单轮 controller 的失败写入语义。

## 验证

`tests/integration/controller-loop.test.ts` 覆盖 Agent throw、无 recovery 的 Gate failure，以及 `FAILED+RETRY` 跨 poll 成功三条路径。
