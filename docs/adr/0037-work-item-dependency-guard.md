# ADR 0037：WorkItem 启动前依赖守卫

三种 `transitionWorkItem*` 写入口在进入 `RUNNING` 前，都在同一事务内要求每个 dependency 存在且为 `SUCCEEDED`。缺失或未完成依赖会在状态更新和事件写入之前拒绝；无依赖和 `BLOCKED → READY` 仍保持原有语义。
