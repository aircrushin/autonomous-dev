# ADR 0059：构建产物携带质量门禁脚本

`pnpm build` 在 TypeScript 编译后把 `scripts/lint.mjs` 与 `scripts/scan-secrets.mjs` 复制到 `dist/scripts`。因此构建后的 `dist/src/verification/runner.js` 生成的 mandatory quality checks 指向构建副本，不回退到源码目录，也不依赖当前 cwd。

构建运行时集成测试复制整个 `dist` 到临时独立目录，使用构建后的 runner 对安全候选和含 `.env` 的违规候选执行检查，分别验证 PASS 与 FAIL。
