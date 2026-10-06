# autonomous-dev

面向个人开发者的 AI 持续开发控制器。

这个仓库的目标是在明确目标、验收标准、授权和预算的范围内，持续调度编码 Agent、隔离执行环境和独立验证器，自动推进软件开发任务；只有在缺少不可替代的人类方向、授权或判断时才暂停。

实施计划见 [docs/implementation-plan.md](docs/implementation-plan.md)。

当前已冻结 Phase 0 的控制面、证据判定、人工介入和技术基线，见 [docs/architecture](docs/architecture/) 与 [docs/adr](docs/adr/)。实现还覆盖 SQLite 持久化、隔离执行、独立验证、租约与恢复、push/PR/merge 适配器、Goal dashboard 和人工等待流程，具体状态见 [docs/implementation-status.md](docs/implementation-status.md)。

CLI 支持 Goal 状态、事件时间线、`dashboard`、人工请求回答和 `operation:cancel`。真实远程 provider、跨进程锁、容器/VM 执行和生产变更仍需外部适配器与授权承载。

## Getting Started

要求 Node.js >= 22。安装依赖并运行统一本地门禁：

```sh
pnpm install --frozen-lockfile
pnpm ci:local
```

`pnpm ci:local` 按 typecheck → lint → secret scan → build → test 顺序执行；任一步失败立即以非零状态停止，确保测试可使用当前构建产物。开发 CLI 使用：

```sh
pnpm devctl
```

验证入口：

- [实施状态与本地证据](docs/implementation-status.md)
- [外部验收 Runbook](docs/external-validation-runbook.md)
- [质量门禁台账](docs/quality-gate-ledger.md)
- [GitHub Actions CI](.github/workflows/ci.yml)

本地测试、fake provider、静态 workflow 和构建产物只证明本地边界，不能替代 hosted CI、真实 GitHub/CI、SSH 主机、Docker/Podman、VM 或生产 metrics 验收。不要把凭据写入命令、日志、artifact 或仓库；真实外部验收须按 Runbook 由用户提供最小授权。
