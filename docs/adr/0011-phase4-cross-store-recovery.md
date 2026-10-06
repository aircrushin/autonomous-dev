# ADR 0011：Phase 4 跨 Store 控制器恢复

控制器进程退出后，新的 `Store` 实例从同一 SQLite 文件读取未结束 Attempt；`runControllerLoop` 先调用持久化恢复，将无有效 lease 的 Attempt 标记为 recovered，再把对应工作项重新置为 `READY` 并继续独立验证门禁。两个独立 Node 子进程的同步 barrier 测试还验证了同一工作项 lease 只有一个 owner 能成功。

集成测试使用两个先后打开的 Store 实例和真实 SQLite 文件，证明 Attempt、恢复事件和后续工作项结果跨进程边界持久化；另使用两个独立 Node 子进程验证 lease fencing。它不证明多主控制器完整调度、远程数据库或生产部署。
