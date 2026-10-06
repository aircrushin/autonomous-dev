# ADR 0007：Phase 8 SSH 远程 workspace 生命周期边界

`SshWorkspaceEnvironment` 在既有 SSH `Command`/`ExecResult` transport 上实现受限的 workspace 生命周期：创建目录、clone、可选 detached checkout、读取 revision 和 porcelain 状态，以及销毁 workspace。

边界约束：

- `workspaceRoot` 必须是非根绝对路径，workspace id 只允许字母、数字、点、下划线和短横线；句柄路径必须精确匹配 root 下的 id。
- 所有生命周期命令均以 argv 传给 SSH transport；cwd 只能位于该 workspace 内，失败时尽力清理已创建目录。
- 这是远程路径和命令构造边界，不代表真实主机隔离、凭据/host key 配置、VM 隔离或真实远程验收。当前测试使用 fake executor。
