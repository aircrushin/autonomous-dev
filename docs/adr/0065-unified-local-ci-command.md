# ADR 0065：统一本地 CI 门禁入口

新增 `pnpm ci:local`，按 typecheck、lint、scan:secrets、test、build 顺序调用现有 package scripts；任一步返回非零即停止并返回非零。GitHub Actions 在 frozen install 后只调用该入口，避免 workflow 与本地门禁出现分叉。
