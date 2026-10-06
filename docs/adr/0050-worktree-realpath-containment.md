# ADR 0050：Git worktree cwd 的真实路径 containment

`GitWorktreeEnvironment.exec` 先通过 `realpath` 解析 workspace 与 cwd，再检查真实 cwd 是否位于真实 workspace 下；词法越界、symlink 指向外部路径均返回 exit code 126 且不执行命令。workspace 或 cwd 不存在时返回受控的 `cwd is unavailable` 回执，不抛未处理异常。真实 workspace 内普通子目录继续执行，环境变量隔离语义保持不变。

集成测试使用真实临时 Git worktree 覆盖 symlink 外指、缺失 cwd、正常子目录和 Phase 2 回归。
