# ADR 0070：声明 pnpm workspace package

`pnpm-workspace.yaml` 增加最小 `packages: ['.']` 配置，同时保留 `allowBuilds.esbuild: true`。这使 GitHub Actions 的 setup-node pnpm cache 能发现 workspace package；不引入额外 workspace、依赖或发布步骤。
