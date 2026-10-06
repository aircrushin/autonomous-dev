# ADR 0048：Git worktree Agent 命令使用最小环境

`GitWorktreeEnvironment` 的 Agent/工作区命令执行器使用 `LocalProcessExecutor({ inheritEnv: false })`。子进程仅获得 PATH/LANG 等最小默认环境，调用方通过 `command.env` 显式传入的变量仍可见；内部 `git` 的 `execFile` 路径保持现状，确保创建、快照和销毁不回归。

集成测试设置 `MUREX_SECRET` 验证 worktree 命令不可见，并验证显式 `MUREX_EXPLICIT` 可见；Phase 2 真实 worktree 流程继续通过。
