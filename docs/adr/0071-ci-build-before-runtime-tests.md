# ADR 0071：CI 先构建再运行测试

`pnpm ci:local` 在 typecheck、lint、secret scan 后先执行 build，再执行 test。构建先行确保 clean checkout 没有残留 `dist` 时，依赖构建产物的运行时测试仍可执行；所有步骤继续复用现有 scripts，任一步失败立即停止。
