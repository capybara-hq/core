---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

The compact drawer follows the approved mockup: a search field and a 新会话 button at the top, the
navigation as one grouped card (收件箱 with its count, 智能体, 定时任务, 更多), 最近会话 with 全部
over the newest conversations by time (not grouped by agent, each with its agent, state and time;
a long press or right click opens rename / archive / delete), and the account as one row at the
foot. The conversations page lists conversations by time in day sections (今天 / 昨天 / 本周 /
更早) with a search and a chip per agent, reads the next page as the end nears (no Load more rows)
and offers each row's actions in an action sheet; on compact the page's primary is a floating
action button. New design pieces: `ConversationList`, `ActionSheet` with `useLongPress`,
`ListFab`, `ScopeChips`, `ListPage.scope`, `formatListTime` / `dayBucket`.
