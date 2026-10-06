# 证据与完成判定

Evidence 必须绑定 `candidateDigest`、验收契约版本、检查定义 digest、环境指纹和输入 digest，并保存原始产物引用。`PASS` 只表示指定候选在指定环境完成了指定检查；`FAIL`、`INCONCLUSIVE`、`ERROR`、超时、跳过、依赖缺失和 Agent 自报都不能推进完成状态。

GateDecision 由控制器根据 Evidence 计算，结果为 `ALLOW`、`REPAIR`、`COLLECT` 或 `ESCALATE`。候选 revision、契约版本、检查定义或授权版本任一变化都会使已有证据失效。验证器定义由控制面加载，Agent 工作区内的测试修改不能降低门禁。
