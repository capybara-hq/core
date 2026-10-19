---
"@capybara-hq/plugin-sdk": minor
---

新增 `ChannelSendError { retryable, retryAfterMs? }` 与 `isChannelSendError`：渠道插件的 `send` / `update`
失败时用它说明能否重试（限流、5xx 可重试；消息被拒、机器人被移出等不可重试）。未使用它的插件不受影响，
其异常由内核按可重试处理（次数有限）。

`ChannelSendArgs` 新增可选的 `idempotencyKey`：内核对同一条逻辑消息的重试传同一个键（普通消息
`"<会话 id>-<事件 seq>"`，卡片状态更新为每张卡片每个状态一个固定键），支持幂等发送的平台应透传以免重复消息。
