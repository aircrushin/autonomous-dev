# ADR 0068：GitHub CI 仅 success 可通过

GitHub check-runs 必须非空且全部结论为 `success` 才返回 PASS。`skipped`、`neutral` 和其他非成功终态结论返回 FAIL；没有 checks 或结论为 null 时保持 PENDING。跳过执行不再被当作验收成功。测试使用 fake fetch 覆盖各结论组合，不宣称 hosted CI 已执行。
