# ADR 0024：GitHub REST provider 适配器

Phase 5 增加 `GitHubPushProvider`、`GitHubPullRequestProvider`、`GitHubMergeProvider` 和 `GitHubCiProvider`，四个类共享一个可注入 `fetch` 的认证 REST transport，分别实现现有窄接口。幂等 key 派生稳定分支名；push、PR 和 merge 在副作用前先读回，副作用后再次读回并校验 revision。CI 读取 check-runs，只有全部结论为 success 时才返回 `PASS`；skipped、neutral 或其他非成功终态结论返回 FAIL（ADR 0068）。

适配器要求调用方显式提供绝对 HTTP(S) base URL、token、仓库和 base branch，并拒绝控制字符、凭据和 fragment。默认使用超时/调用方 AbortSignal；非 2xx、transport 和超时错误统一映射为不含 token 的 `GitHubApiError`。PR 创建和 merge 成功后都会再次查询并校验 head revision/status，以处理响应丢失后的幂等重试。测试使用 fake fetch，覆盖请求头、URL、幂等读回、revision fencing 和错误映射；没有真实 GitHub 凭据或托管服务验收。
