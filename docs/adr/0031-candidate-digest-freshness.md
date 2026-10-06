# ADR 0031：验证前解析候选 digest

## 决策

控制器可在 Agent 回执后、独立验证前调用 `resolveCandidateDigest`。成功返回的非空 digest 替代输入中的候选值，并同时写入验证结果、Evidence 和控制器回执；解析失败或空值会使本轮失败且不写 Evidence。

## 原因

Agent 可能在执行期间改变工作区。验证必须绑定 Agent 完成后的实际候选版本，不能继续使用进入本轮时的旧 digest。

## 兼容边界

未提供 resolver 的旧调用仍使用 `input.candidateDigest`；该兼容路径不改变既有 API。交付流水线和外部 provider 不在本 ADR 范围内。
