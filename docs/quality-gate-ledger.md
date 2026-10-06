# 质量门禁台账

本台账记录当前工作区可复核的本地证据，不把 fake、静态检查或独立 QC 误写成 hosted、真实远端或生产证据。`181/181` 是 ADR0069 时点的本地全量测试基线；新增本台账测试后，当前工作区全量数字会相应变化。

| Phase | ADR 与源码/测试证据 | Independent QC | 未覆盖边界 |
|---|---|---|---|
| Phase 0 | `docs/architecture/`、`docs/state-transitions.md`、ADR 0001–0016 | 已完成本地审查与门禁 | hosted/生产架构运行证据 |
| Phase 1 | `src/storage/database.ts`、`tests/unit/storage.test.ts`、ADR 0030/0033/0037/0038/0042/0043/0044/0046/0047/0049/0054 | storage focused 与全量回归均通过 | 跨机数据库和生产迁移 |
| Phase 2 | `src/environments/`、`tests/integration/phase2-e2e.test.ts`、ADR 0035/0048/0050/0059/0062/0063 | phase2/controller focused、全量、typecheck/build 通过 | 真实远端 Agent、主机与凭据 |
| Phase 3 | `src/verification/runner.ts`、`tests/integration/verification.test.ts`、ADR 0031/0056/0057/0060/0061 | verification/observability focused 与全量通过 | 所有真实检查类型、远程 artifact 长期保留 |
| Phase 4 | `src/controller/loop.ts`、`src/recovery/`、`tests/integration/controller-loop.test.ts`、ADR 0039/0040/0051/0052/0053/0073 | controller/recovery focused 与全量通过；崩溃接管测试使用 1000ms lease TTL 和 1200ms 有界等待，保留真实 SIGKILL/过期接管断言 | 进程管理器、跨机 soak、无限期活性 |
| Phase 5 | `src/delivery/`、`tests/integration/delivery.test.ts`、`github-provider.test.ts`、ADR 0024/0032/0055/0068/0072 | delivery focused 与全量通过；ADR0069 QC 只读 preflight 文档测试 1/1；hosted run 37404982889 的 `verify` job 成功执行 frozen install 与 `pnpm ci:local` | PR/merge 对账、真实 merge、外部回写 |
| Phase 6 | `src/policy/`、HumanRequest storage/controller tests、ADR 0054 | phase6 focused 与全量通过 | 真实人工授权渠道与身份系统 |
| Phase 7 | `src/observability/`、`tests/unit/export.test.ts`、`observability-http.test.ts`、ADR 0020/0026/0028/0061 | observability focused 与全量通过 | 生产认证/TLS、远程抓取与 metrics 部署 |
| Phase 8 | `src/controller/scheduler.ts`、`src/environments/remote-ssh.ts`、`container.ts`、`tests/integration/remote-ssh.test.ts`、`container.test.ts`、ADR 0041/0045/0064/0065/0070 | local CI、typecheck/build/lint/scan 与全量通过；pnpm workspace package 配置通过 focused test | 真实 SSH、Docker/Podman daemon、VM、多 Agent、部署 |

标准门禁为 `pnpm ci:local`：typecheck → lint → scan:secrets → build → test，任一步失败即非零停止。当前证据仅包含记录在 ADR0072 的一次 GitHub hosted run；不包含 PR/merge 对账、真实远端主机、容器 daemon、VM、生产 metrics 或任何外部凭据操作。
