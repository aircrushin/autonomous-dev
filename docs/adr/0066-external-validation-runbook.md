# ADR 0066：外部验收分阶段 Runbook

新增 `docs/external-validation-runbook.md`，覆盖 hosted Actions、PR/CI/merge 对账、SSH、Docker/Podman、VM/跨机 Agent 和 metrics 认证/TLS/生产只读验收。每阶段明确只读 preflight、用户授权/凭据边界、成功证据与失败停止条件，并声明本地 static workflow 和测试不能替代 hosted evidence。
