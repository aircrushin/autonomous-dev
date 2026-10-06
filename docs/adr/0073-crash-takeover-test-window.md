# ADR 0073：崩溃接管测试使用有界租约窗口

独立 controller 硬崩溃接管测试仍使用真实 `SIGKILL`、lease 过期和第二进程接管断言，但将 leader lease TTL 从 100ms 提高到 1000ms，并以 1200ms 有界等待重试。这样测试不依赖 hosted runner 在 100ms 调度窗口内完成 SQLite/Node 调度，同时仍要求等待租约自然过期后接管；不会放宽接管或终态断言。
