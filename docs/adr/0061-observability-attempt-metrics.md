# ADR 0061：Observability 暴露 Attempt 成功指标

Dashboard JSON 与 Prometheus 导出复用持久化 Attempt 的 `startedAt`、`endedAt`、`result`，提供 Attempt 总数、成功数、失败数和已完成耗时总和；timeline 事件提供 retry/recovery 计数。无数据时输出稳定的零值，非法或未完成耗时不计入总和，不臆造 cost 或需求覆盖率。
