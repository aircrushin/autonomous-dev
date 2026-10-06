# ADR 0055：CI 轮询间隔必须是有限非负数

`waitForCi` 对 `options.intervalMs` 做边界校验：必须是 finite 且大于等于 0。零值保留给本地测试和无延迟轮询；负数、`NaN` 与正负无穷在调用 provider 前拒绝。`maxPolls` 和既有轮询、`ExternalWaitError` 语义保持不变。

集成测试覆盖零间隔正常轮询及全部非法数值，确保校验失败不触发 provider 调用。
