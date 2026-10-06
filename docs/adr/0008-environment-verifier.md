# ADR 0008：独立验证器的执行环境注入

`verifyChecks` 接受可选 `executor: CommandExecutor`，控制器通过 `verificationExecutor` 传入。每项检查将原始 argv、workspace cwd、超时（默认 120 秒）和输出上限（16 MiB）交给指定执行器。未配置时继续使用既有本地 `execFile` 路径，保持调用兼容。

SSH/容器执行器可直接传入。已有 `EnvironmentAdapter` 与 workspace handle 可通过 `{ exec: command => environment.exec(handle, command) }` 绑定；调用方负责创建、快照和销毁环境，并提供与真实环境对应的 `environmentFingerprint`、候选 digest。注入本身不能证明隔离强度或这些输入的真实性。

回执规则：超时为 `INCONCLUSIVE`；输出截断、transport error 或执行器抛错为 `ERROR`；非零退出为 `FAIL`；零退出为 `PASS`，但保持既有规则：非 required 检查有 stderr 时为 `INCONCLUSIVE`。执行器报错不会回退本机，也不会阻断其他检查收集证据。Evidence 的候选、契约和环境绑定方式保持不变。

测试使用 fake executor 验证参数、状态映射、错误诊断和控制器 Gate 拒绝语义，默认本地验证路径仍有真实进程测试。本里程碑不声称已验收真实 SSH 主机、容器 daemon 或远程凭据。
