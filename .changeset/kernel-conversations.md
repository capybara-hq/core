---
"@capybara-hq/kernel": minor
---

新增会话与只追加的事件日志（迁移 `0006_conversations.sql`：`conversations`、`conversation_events`、`runs`）：`EventLog` 在会话行锁内连续分配 seq、支持幂等键，提交后在内核总线主题 `conv.<id>` 发布 `{ kind: "events", toSeq }`；`/api/v1/orgs/:orgId/conversations` 创建 / 列表（`next` 游标）/ 读取 / 读事件（`?after=`）/ 发消息（202，`clientMessageId` 幂等），只允许人类用户且只有会话所有者可见，每次访问实时复核 agent 仍可用；错误码 `conversation.not_found`。
