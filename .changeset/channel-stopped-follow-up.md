---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
---

渠道出站投递：任务因不可重试失败（target_gone / auth / 未满毒事件次数）停止本轮时，若本次尝试开始之后会话又有
新事件，结束时复核再排一个任务。此前这些事件的投递任务见锁被占直接结束，持锁任务停下又不复核，「后续事件触发续投」
在失败请求较慢时会丢。测试工具：`startFakeChannelServer` 的 `failNext` 新增 `delayMs`（推迟失败响应）。
