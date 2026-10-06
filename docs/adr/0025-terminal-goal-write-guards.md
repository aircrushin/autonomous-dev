# ADR 0025：终态 Goal 的持久化写入守卫

终态 Goal（`SUCCEEDED`、`CLOSED_UNACHIEVABLE`）不再接受新的 WorkItem、HumanRequest、预算预留、Evidence 或带 Goal 的 Operation。已有幂等 Operation 查询仍可返回既有记录，便于进程重启后的只读对账；新的业务写入必须先经过同一 `assertGoalMutable` 边界。

该守卫覆盖普通 Evidence 和带租约 Evidence，避免控制器或迟到执行器在 Goal 已结束后写入新的完成依据。测试只验证本地 SQLite 状态和事务回滚语义。
