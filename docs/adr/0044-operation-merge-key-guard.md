# ADR 0044：Operation merge idempotency key 终态守卫

`setOperationMergeIdempotencyKey` 在事务内先读取 Operation。`PENDING`/`UNKNOWN` 首次设置 key 会写入并记录事件；已有相同 key 是幂等重读，不重复事件；不同 key 拒绝。`SUCCEEDED`/`FAILED` 拒绝任何新 key，失败事务不修改 Operation 或追加事件。不存在的 Operation 也保持原子失败。

单元测试覆盖成功/失败终态、首次设置、同 key 重试、冲突 key 和失败无脏写。
