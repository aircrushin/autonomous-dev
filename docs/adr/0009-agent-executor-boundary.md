# ADR 0009：编码 Agent 的执行器边界

`CommandAgentAdapter` 通过注入的 `CommandExecutor` 运行编码 Agent 命令，并把 bounded executor 的超时、输出上限、启动错误和非零退出统一映射为失败回执。它不会在执行器失败时回退到控制器本机。

现有 `ShellAgentAdapter` 保留兼容；调用方可以把 SSH、容器或本地 executor 传给新适配器。`AgentRunInput.runId` 可由调用方预先提供，便于在 in-flight 期间调用 `cancel`；由于 `CommandExecutor` 当前没有进程句柄，取消请求只能把最终回执 fencing 为 `CANCELLED`，实际终止仍由 executor 的超时和进程组策略负责。`resume` 不会隐式重放旧命令，要求上层创建带新 command 的 run。持久日志只记录执行回执元数据，不写入命令 argv 或 stdout/stderr，避免把凭据和仓库内容写入日志。测试使用 fake executor，未证明真实 Agent、SSH 主机或容器 daemon。
