# ADR 0064：最小 GitHub Actions 本地质量门禁

`.github/workflows/ci.yml` 在 push 和 pull request 上使用 Node 22、pnpm frozen lockfile 安装，并按固定顺序运行 typecheck、lint、secret scan、test 和 build。Workflow 仅声明 `contents: read`，不读取 secrets，不执行发布、push 或部署。

当前工作区没有 GitHub Actions 运行记录，因此本 ADR 只证明 workflow 静态结构和本地命令；未宣称 GitHub hosted runner 已执行。
