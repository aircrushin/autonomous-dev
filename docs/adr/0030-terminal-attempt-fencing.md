# ADR 0030：终态 WorkItem 拒绝迟到 Attempt 完成

## 决策

`Store.finishAttempt` 在事务内先绑定 Attempt 所属 WorkItem。若 WorkItem 已进入 `SUCCEEDED` 或 `BLOCKED`，拒绝迟到的完成写入；带 lease 的调用继续要求 resource、owner 和有效期匹配。

## 原因

执行器可能在控制器已经提交终态后才返回。允许它写入旧 Attempt 会破坏终态不可变边界，并让迟到回执看起来像当前执行结果。

## 边界

无 lease 的历史 API 保持兼容，只增加终态 WorkItem 守卫；新的受控执行路径仍通过带 lease 的 `finishAttempt` 防止旧 owner 写入。
