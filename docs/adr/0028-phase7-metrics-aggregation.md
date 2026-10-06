# ADR 0028：Prometheus scrape 聚合边界

## 状态

已接受。

## 决策

新增 `aggregatePrometheusScrapes`，只聚合调用方已经取得的 Prometheus 文本，不负责网络访问。每个 scrape 必须有唯一的非空 `sourceId`；HELP/TYPE 元数据和样本格式必须来自当前 exporter 契约，冲突或非法输入直接拒绝。

counter 始终按同名且同标签集合求和，gauge 必须使用显式 `sum` 或 `max` 策略（默认 `sum`）；组合值溢出为非有限数时拒绝结果。输出按 metric 名称和标签键使用明确的 UTF-16 code-point 顺序排序，保留 exporter 的 HELP/TYPE，标签值按 Prometheus 规则转义，并且不增加 source label，避免改变现有指标语义。

## 证据边界

单元测试覆盖多 source、重复 source、同源重复样本、gauge max、counter sum、标签转义、元数据冲突和非法行。测试不证明远程抓取、认证、TLS 或时序数据库写入。
