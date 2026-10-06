# ADR 0041：LocalProcessExecutor 默认边界校验

`LocalProcessExecutor` 的 per-command 参数已经拒绝非正 timeout 和非正整数输出上限；构造函数默认值此前未校验，可能把 `NaN`、无穷大或非法输出上限带入执行路径。构造时现在复用同一错误风格校验：`defaultTimeoutMs` 必须为 finite positive number，`defaultMaxOutputBytes` 必须为 positive integer。合法默认值继续通过现有 argv/no-shell 执行路径。

集成测试覆盖 0、负数、NaN、Infinity（输出上限另覆盖小数）以及合法默认值实际执行。
