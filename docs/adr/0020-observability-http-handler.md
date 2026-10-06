# ADR 0020：只读可观测性 HTTP handler

Phase 7 提供 `createObservabilityHandler(store)`，由调用方挂载到 Node HTTP server。`GET /metrics` 输出全局 Prometheus timeline；`GET /metrics?goal_id=...` 输出指定 Goal；`GET /dashboard/:goalId` 输出稳定 JSON，使用 `format=prometheus` 时输出 dashboard 指标；`GET /timeline` 输出全局 JSON 时间线。

handler 只读，不自行监听端口、不处理认证；调用方负责绑定地址和访问控制。未知资源返回 404，非 GET 返回 405，缺失 Goal 返回 404，未知格式或非法 URL 编码返回 400。响应设置 `no-store`，避免状态面板被缓存。

集成测试使用真实临时 Node HTTP server 和 fetch，覆盖 JSON、Prometheus、缺失资源和方法边界；这不代表公网暴露、认证、远程 metrics aggregation 或生产 TLS 已接入。
