# ADR 0009：CommandExecutor 驱动的 Agent 适配器

## 状态

已接受。

## 决策

`CommandAgentAdapter` 只依赖 `CommandExecutor` 的 `Command`/`ExecResult` 契约，不在 Agent 层回退到本机 `child_process`。调用方可以注入本地有界进程、SSH 或容器执行器，保持工作区、超时、输出上限和环境边界由执行器统一管理。

适配器保留现有 `AgentAdapter` 语义：按 work item 计算 `maxRuns`，每次运行写入结构化 JSONL 日志，非零退出、超时、输出超限和执行器错误都映射为 `FAILED`，显式取消映射为 `CANCELLED`。`resume` 仍要求调用方提供新的 command，通过 handoff 的下一步提示避免隐式重放旧命令。

## 证据边界

fake executor 集成测试覆盖成功、非零退出、超时、输出上限、执行器抛错、预算、取消、日志和 resume。测试证明适配器映射契约，不证明真实远程主机、容器 daemon 或 Agent 服务凭据可用。
