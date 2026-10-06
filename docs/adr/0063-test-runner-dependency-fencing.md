# ADR 0063：标准 test runner 的间接依赖 fencing

当检查命令是 `pnpm test`、`npm test` 或 `yarn test` 时，controller 额外把候选 workspace 的 `package.json` 和 `tests/` 下受支持文本文件纳入检查依赖 digest。Agent 修改测试断言或 test script 后，旧验收被拒绝；未修改时仍按真实 runner 结果判断。shell 拼接命令和外部 runner 的间接依赖不猜测，继续由显式命令或环境适配器负责。
