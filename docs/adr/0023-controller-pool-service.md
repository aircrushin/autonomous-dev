# ADR 0023：可中止的 controller pool worker

`runControllerPoolWorker` 由调用方持有 `Store` 和 `ControllerLoopInput`，以每个 Goal 一次有界 turn 反复调用现有 `runControllerPool`。每次轮询结束后检查工作项终态；全部工作项为 `SUCCEEDED` 或 `BLOCKED` 时退出，未完成时按 `pollIntervalMs` 等待。`maxTurns` 和 `maxIdlePolls` 为常驻进程提供显式边界，`controllerId` 可透传 Goal leader lease。

worker 接受 `AbortSignal`。信号触发后不额外迁移工作项，当前已持久化的 Attempt、Evidence 和 WorkItem 状态保留给下一次 controller 恢复；返回值标记 `ABORTED` 并报告最后一轮结果。零间隔轮询也通过 timer 让出事件循环，避免忙循环阻塞停机信号。该封装提供本地常驻进程的生命周期边界，不声称已完成进程管理器、跨机部署或真实外部执行器验收。
