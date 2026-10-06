# ADR 0052：Controller 仅执行可运行 Goal

Controller round/loop 现在只允许 Goal 状态 `DRAFT`、`PLANNING`、`RUNNING`。`FAILED` 与 `RECOVERING` 也直接短路，返回 deferred/skipped，不获取 WorkItem lease、不调用 Agent、不修改 WorkItem。WorkItem 层已有的 `FAILED+RETRY` 恢复仍在 Goal=RUNNING 下执行；Goal recovery 状态由外部恢复编排完成后再回到可运行状态。

测试覆盖 FAILED/RECOVERING direct round 与 loop 防线、Agent 调用数为零、WorkItem/Goal 不变，以及既有 RUNNING Goal retry/recovery 回归。
