---
"@capybara-hq/plugin-sdk": minor
---

新增 `ChannelSendError { retryable, retryAfterMs? }` 与 `isChannelSendError`：渠道插件的 `send` / `update`
失败时用它说明能否重试（限流、5xx 可重试；消息被拒、机器人被移出等不可重试）。未使用它的插件不受影响，
其异常由内核按可重试处理（次数有限）。

`ChannelSendArgs` 新增可选的 `idempotencyKey`：不超过 40 个 `[A-Za-z0-9_-]` 字符，同一条逻辑消息的每次重试都相同
（内核由「会话 + 事件 seq」或「卡片 + 状态」稳定哈希得到），支持幂等发送的平台应透传或映射以免重复消息。
