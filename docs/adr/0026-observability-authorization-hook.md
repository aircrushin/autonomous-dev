# ADR 0026：Observability handler 的调用方授权钩子

只读 HTTP handler 接受可选的同步 `authorize(request)`。钩子在解析路由和读取 Store 之前执行，返回 `false` 或抛出异常时统一 fail closed 返回 401，避免未授权请求观察 Goal、事件或证据。默认不提供钩子以保持本地 CLI/临时 server 兼容。

handler 不负责 token、TLS、mTLS、会话或远程 metrics aggregation；这些仍由调用方和部署层提供。集成测试使用临时 Node server 验证未授权请求不会进入查询路径，授权请求保留现有 JSON/Prometheus 行为。
