# ADR 0032：Goal 级交付生命周期

`deliverGoalCandidate` 要求 Goal 从 `VERIFYING` 进入 `DELIVERING`，复用现有幂等交付流水线，回读成功 Operation 后才进入 `SUCCEEDED`。失败保留 `DELIVERING`，新进程通过已持久化 Operation 对账继续。已成功 Goal 必须具有同 Goal 的成功 PR/merge 回执，才能进入既有只读重试分支。

真实临时 Git 与 fake provider 测试覆盖首次交付、终态重试，以及 PR 已创建但回执丢失后的 SQLite 重启恢复。此边界不改变外部 provider，也不证明真实 GitHub 部署验收。
