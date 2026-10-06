# ADR 0060：标准 Controller 默认强制质量门禁

`runControllerRound`/`runControllerLoop` 即使省略 `qualityProfile`，也会自动追加 canonical `quality-lint` 与 `quality-secrets` 检查并绑定候选 workspace。调用方若提供同 ID 的伪造命令会拒绝；自定义检查继续保留。质量检查在本地候选 workspace 使用真实脚本，在远程/不存在路径使用注入 executor，避免破坏远程适配器边界。

底层 `verifyChecks` 仍允许显式非 mandatory 调用；标准 controller 不得通过省略 profile 绕过 §11.1 的 lint 和秘密/危险文件扫描。
