# ADR 0006：Phase 8 Docker/Podman 容器执行边界

Phase 8 增加可选的 `ContainerCommandExecutor`，把同一个 `Command`/`ExecResult` 契约映射到 Docker 或 Podman 的 `run` argv。它的边界是：

- runtime、镜像、workspace 和容器内工作目录在构造或执行前校验；调用方命令始终作为独立 argv 传入，不通过控制器 shell 拼接；
- 每次运行固定使用 `--rm`、`--init` 和 `--network none`，并显式以 bind mount 暴露唯一 workspace；workspace 可以配置只读挂载；
- `cwd` 只能映射到 workspace 内的容器路径，`env` 逐项编码成 `--env KEY=VALUE`；宿主调用方环境不会被传给容器 runtime；
- runtime transport 复用 `LocalProcessExecutor`（或注入的 `CommandExecutor`），因此超时、进程终止、stdout/stderr 总量上限、非零退出和启动错误诊断保持同一语义；返回结果的 `argv` 仍是调用方原始命令；
- 测试使用 fake executor 验证 runtime argv、workspace mount、cwd/env 映射、输入拒绝和回执传递，不连接 Docker/Podman daemon，不能证明真实容器启动、镜像供应链、内核隔离、rootless 配置、workspace 生命周期或生产安全性。

该适配器只解决单次命令的容器 transport。它不负责构建/拉取镜像、凭据、远程 runtime、容器持久化、多主机调度、workspace snapshot/destroy 或 VM 隔离；这些能力必须作为独立适配器并单独做真实环境验收。
