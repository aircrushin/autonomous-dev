# ADR 0054：HumanRequest 必须从 OPEN 创建

`Store.createHumanRequest` 只接受 `status='OPEN'`。初始 `ANSWERED` 或 `CLOSED` 请求在事务入口拒绝，不写 row/event；回答与关闭仍通过专用流程完成，`createHumanRequestAndPause` 的 OPEN 语义保持不变。终态 Goal 的写入守卫继续生效。

单元测试覆盖非法初始状态、OPEN 创建、`answerHumanRequest` 专用流程和失败无脏写。
