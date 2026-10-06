# ADR 0012：Phase 4 持久化重试与无进展门禁

`runControllerLoop` 可为工作项启用 `recovery: { maxAttempts, strategy }`。Gate 未放行时，控制器把 Gate、验证状态、Agent 结果和策略组成稳定失败指纹，写入 SQLite `retry_state`；新指纹且未超预算时执行 `FAILED → READY` 并重新运行。相同指纹返回 `NO_PROGRESS`，预算耗尽返回 `BUDGET_EXHAUSTED`，两者都会停止该工作项。

未配置 `recovery` 时保留原有单轮行为。控制器重启时只恢复 `last_decision=RETRY` 且仍在预算内的 `FAILED` 工作项，避免重复执行已停止的失败。测试覆盖首轮失败、次轮成功、相同失败停止和重启窗口恢复；策略切换由调用方根据当前工作项/重试状态选择 Agent。真实外部 Agent 和生产策略仍不在本 ADR 的验收范围内。
