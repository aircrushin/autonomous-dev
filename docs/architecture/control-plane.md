# 控制面架构冻结

控制器是唯一可以改变 Goal、验收契约、授权策略和交付资格的组件。Agent 只产生候选 revision 与日志；验证器只读取候选并写入不可变 Evidence。三者当前编译在一个 Node.js 进程中，但通过模块接口保持边界。

SQLite 事务同时写业务快照和 append-only `events`；事件序号由数据库生成，恢复以快照为准并以事件日志审计。工作区租约、预算扣减和状态迁移必须在同一事务内完成。Git worktree 只隔离源码目录，不提供凭据或系统调用沙箱。

控制面不允许 Agent 写入 `src/contracts`、`src/verification`、验收契约或授权策略。候选代码变化后，旧 Evidence 的 candidate digest 不再匹配，必须重新验证。
