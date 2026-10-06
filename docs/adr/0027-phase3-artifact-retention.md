# ADR 0027：验证产物的本地保留边界

## 状态

已接受。

## 决策

新增 `pruneVerificationArtifacts(directory, options)`，只扫描 verifier 生成的固定 `NNN+<24 hex>-stdout.log` 和 `NNN+<24 hex>-stderr.log` 文件名（索引至少三位，支持超过 999 的批次）。它使用 `lstat`，跳过符号链接和目录，不递归，也不触碰同一目录中的非产物文件。

清理先按 `maxAgeMs` 删除过期文件，再按最旧优先满足可选的 `maxBytes` 上限。目录不存在按空目录处理，并返回删除数、保留数和字节统计；该边界不改变 verifier runner，也不声称提供远程对象存储或跨主机保留。

## 证据边界

集成测试覆盖新文件保留、过期删除、字节上限、非产物文件和符号链接安全。测试证明本地文件系统边界，不证明远程 artifact 存储、跨进程协调或生产保留策略。
