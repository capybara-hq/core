---
"@capybara-hq/kernel": minor
---

第一段渠道修复：入站持久化（插件 `onEvent` 只去重并排入 `cap-kernel-channels` 的 `inbound` 任务，worker 处理，
失败按 BullMQ 退避重试 5 次；选主停机时等进行中的 `onEvent`）；组织软删除后其连接立即断开、入站与卡片操作不再处理；
组织停用插件时广播 `channel.changed`（长连接立即断开），入站与卡片操作实时复核启用；滚动升级期间没有加载插件的副本
不取租约、不记失败，出站任务推迟重试；插件停用时仍可轮换连接凭据（跳过 verify，响应 `verifySkipped: true`）；
发送带组织语言 `locale`，按 `ChannelSendError.reason` 处理（auth 记 last_error 不计毒事件、target_gone 只停止本轮），
草稿编辑被拒改发新消息，草稿节流取 `max(1s, features.minEditIntervalMs)`；外部租户的发言人只能绑定，绑定确认显示
平台给的显示名；第三方登录的 bind 身份升级须发起与回调是同一已登录账号；`GET /me/identities` 带 `linkedVia`。
迁移 0020（卡片查找唯一索引、通讯录排除外键索引）。
