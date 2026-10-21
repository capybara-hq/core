---
"@capybara-hq/kernel": minor
---

渠道按声明的 `features` 发送（Ruling A33）：`features.cards` 为 false 的渠道，出站投递与入站回复里的卡片按
`renderCardAsText(card, locale)` 退回为文本、拼在正文之后，交给插件的消息不再带 `cards`；`features.threads` 为 false
的渠道，交给插件的目标不带 `threadId`。插件权限清单里「提供」一组含 `channel@1`（收到组织在 IM 里的对话）时也标为敏感。
