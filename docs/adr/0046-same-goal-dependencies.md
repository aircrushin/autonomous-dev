# ADR 0046：WorkItem dependency 必须属于同一 Goal

`createWorkItem` 在事务内要求每个 dependency 已存在且 `dependency.goalId` 与新 WorkItem 相同；缺失或跨 Goal 时拒绝并回滚 row/event。为兼容旧库，`assertDependenciesReady` 在三种 `RUNNING` transition 入口再次校验 dependency 所属 Goal，防止旧跨 Goal 数据被执行。成功的同 Goal、已 `SUCCEEDED` dependency 仍按原有路径运行。

测试覆盖创建拒绝、旧跨 Goal 数据在普通/lease/版本校验入口拒绝且无脏写，以及同 Goal dependency 正常运行。
