# ADR 0005：Phase 8 SSH 远程命令传输边界

Phase 8 增加 `SshCommandExecutor` 作为可替换的远程命令传输适配器。它遵循与 `LocalProcessExecutor` 相同的 `Command`/`ExecResult` 契约：

- 控制器只用 `spawn` 的 argv 形式启动 `ssh`，固定 `shell: false`；远程参数逐项做 POSIX 单引号编码；
- `target`、端口、SSH 参数和远程环境变量在构造或执行前校验，调用方环境默认不继承；
- SSH transport 复用本地有界执行器，因此超时、进程终止、stdout/stderr 总量上限、远端非零退出和启动错误诊断保持一致；
- `cwd` 与 `env` 会编码进远端命令串，结果的 `argv` 仍保留调用方原始命令，便于证据和审计；
- 测试使用 fake SSH executable 验证 argv、编码、超时、输出上限和错误路径，不连接真实主机，也不能证明远端主机隔离、凭据配置、网络连通性或生产安全性。

该适配器只解决命令传输，不实现远端 workspace 创建、snapshot、destroy、容器/VM 隔离或多主机调度。未来若接入真实远端环境，必须在同一契约上补齐身份、主机密钥、工作区生命周期和回读证据，并单独进行真实环境验收。
