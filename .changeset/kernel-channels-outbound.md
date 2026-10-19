---
"@capybara-hq/kernel": minor
---

渠道出站投递：新队列 `cap-kernel-channels`（worker 角色消费，任务 id `deliver-<会话>-<seq>`）按
`channel_deliveries.last_seq` 把会话输出续投到 IM——首个增量发草稿、至多每秒更新一次、`assistant_message` 定稿
（`features.edit` 为 false 的渠道只发定稿），不发 thinking；`approval_requested` / `question_asked` /
`connection_required` 发内核定义的卡片（审批参数预览按键名打码并截断到 500 字符，链接用 `http.publicUrl`），
`approval_decided` / `question_answered` 更新对应卡片（卡片消息 id 记在新表 `channel_card_messages`，迁移 0018 原地追加）。
每投递一个事件就在同一事务推进 `last_seq` 并记下 IM 消息 id，崩溃后其他副本从 `last_seq` 续投、不重发；
可重试的发送失败按 BullMQ 退避重试，不可重试的记连接 `last_error` 并停止该会话本轮投递。
IM 卡片按钮（`card_action`）按点击者映射到的账号调用 `ApprovalsService.decide` / `QuestionsService.answer`，
无权者收到一句说明、未绑定者收到绑定提示（群里只提示去私聊）。运行开始、审批 / 回答、等待中中止后都会排出站任务。
流式增量的总线消息新增 `offset`（本步已推出的文本字符数）。

投递任务追上后 `channels.deliveryIdleMs`（默认 15000）内没有新输出即结束，会话之后的每次日志推进都会再排任务；
新配置 `channels.deliveryConcurrency`（默认 100）。运行失败 / 结束时挂着的草稿收尾为「已有文本 + 失败说明」；
卡片操作要求卡片由本连接发在同一 chat，匿名访客只能处理自己话题里的卡片且只能「仅此一次」；同一事件不可重试地失败
3 次后跳过并提示去网页查看（`channel_deliveries` 新增 `fail_seq` / `fail_count`）；发送时带幂等键。
