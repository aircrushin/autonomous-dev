# ADR 0045：SSH workspace 目录所有权

`SshWorkspaceEnvironment.create` 先确保 `workspaceRoot` 存在，再使用不带 `-p` 的 `mkdir -- <workspacePath>` 原子占用目标目录。只有占用命令成功后才拥有该 path；目标已存在、被占用或占用失败时 create 直接失败且不执行 `rm -rf`。clone、checkout、rev-parse 在已占用的自有目录上失败时仍执行 best-effort cleanup。成功路径的 destroy 继续由调用方显式执行。

fake remote-workspace 测试覆盖预存在目录、占用失败、自有目录中途失败清理及更新后的命令序列。
