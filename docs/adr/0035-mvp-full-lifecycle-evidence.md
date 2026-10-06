# ADR 0035：MVP 全链路本地验收

新增一条真实临时 Git 集成验收，串联 GoalPlan、Git worktree、LocalProcessExecutor、CommandAgentAdapter、后置 candidate digest、独立 verifier、Evidence、Goal 交付和 SQLite 重启后的幂等 Operation 对账。测试只使用 fake CI/push/PR provider，不把本地结果扩展为真实远程服务承诺。
