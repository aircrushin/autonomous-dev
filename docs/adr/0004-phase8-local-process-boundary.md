# ADR 0004：Phase 8 本地进程执行边界

Phase 8 先把本机执行做成可替换的 `LocalProcessExecutor`，再接入容器、虚拟机或远程执行器。执行器的约束是：

- 使用 `spawn` 的 argv 形式，固定 `shell: false`，不把命令字符串交给 shell 解析；
- 默认不继承调用方环境，只保留最小 `PATH`/`LANG`，额外变量必须显式传入；
- 对 argv、环境变量名、超时和 stdout/stderr 捕获量做输入校验；
- 启动为独立进程组，超时或输出超限时终止整个进程组，并返回可判定的 `timedOut`/`outputLimitExceeded` 结果；
- `GitWorktreeEnvironment` 继续负责 worktree cwd 边界，并复用该执行器。

这不是容器或 VM：进程仍与控制器共享主机内核、文件系统和用户权限。调用方若显式启用 `inheritEnv`，也必须把它视作扩大权限边界的配置。未来容器/VM/远程适配器应实现同一 `EnvironmentAdapter`/`Command` 契约，并保留这些超时、输出和回读语义。
