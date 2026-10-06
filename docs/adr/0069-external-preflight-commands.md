# ADR 0069：外部验收只读 preflight 命令

外部验收 Runbook 增加可执行只读模板：GitHub Actions/PR 状态读取、SSH `pwd`/`git --version`、Docker/Podman version/inspect、VM 节点描述读取和 metrics HTTPS health/GET。所有真实值使用尖括号占位符，禁止把凭据写入命令；不提供 push、merge、publish、deploy、scale、pull 或容器启动命令。Runbook 仍要求失败立即停止并记录脱敏证据。
