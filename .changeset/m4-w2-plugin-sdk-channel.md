---
"@capybara-hq/plugin-sdk": minor
---

`channel@1` 补充（Slack / 飞书插件冻结前）：`ChannelSendArgs.locale`（组织语言，必填）；入站事件的发言人类型
`InboundSender` 增加可选 `displayName`、`avatarUrl`；`ChannelSendError.reason`（`auth` / `target_gone` / `rejected` /
`too_large`）；`features.minEditIntervalMs`；在注释中写明契约：`onEvent` resolve 后才向平台确认、reject 不确认，
超长文本由插件拆分并返回最后一条的 id，`text` 去掉 @ 机器人，M4 只处理文本、编辑 / 撤回不发事件，
`card_action` 的 `messageId` 为卡片消息 id、群里必须带 `target.threadId`。
`card_action` 增加可选 `eventId`（内核据此去重平台重投），群里可不带 `threadId`；注释补充 `messageId` 在连接内唯一、
群聊 `threadId` 为话题根消息 id（Slack `thread_ts`、飞书 `root_id`）、`tenantId` 口径（Slack team id、飞书 `tenant_key`）、
`update` 超长时抛 `too_large`（内核改发新消息）、`onEvent` 的去重范围。
