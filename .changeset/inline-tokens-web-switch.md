---
"@capybara-hq/capybara": patch
"@capybara-hq/design": patch
---

The composer switches to inline tokens: everything picked through `/` or `@` (a skill, a
connector, a connector resource, a library file, a conversation) and ＋ 项目文件 picks stand in the
sentence as tokens, while uploads stay cards. `@` lists the agent's connectors first (→ opens a
connector's resources), then files and conversations; ＋ loses 连接器资源 and its connector rows
insert a token. At most one skill per message. A message goes out as `text` with one U+FFFC per
token and its `tokens`; a refusal marks the token and offers 移除. Bubbles draw a message's tokens
from `payload.inline`, the skill chip first. The design adds `openTrigger` / `setTriggerQuery` to
the editor's handle and a `@capybara-hq/design/testing` entry with the editor's test drivers;
`FileDrop` leaves a paste a child already took alone.
