# ADR 0058：Controller loop 透传并锁定 mandatory quality profile

`ControllerLoopItemConfig` 增加可选 `qualityProfile: 'mandatory'`，由 loop 原样透传至 `runControllerRound` 和 verifier。启用该 profile 时必须提供 `quality-lint` 与 `quality-secrets`，且两者命令 argv 必须等于 `mandatoryQualityChecks(workspace)` 的 canonical 定义；调用方不能用 `true` 或其他命令伪造质量门禁。扫描命令始终接收当前候选 workspace 参数。

未启用 profile 的旧 loop 配置保持原语义；自定义检查仍按原有顺序执行。缺少 mandatory 检查或命令被篡改时在 Agent 执行前拒绝，正常候选 workspace 可通过质量门禁。
