---
"@capybara-hq/web": minor
---

Chat-first compact navigation; the Me page is retired. The home and a conversation are chat
surfaces (menu button with the inbox count), every other page is pushed (back). The drawer holds
收件箱 (with its count), 智能体 and 定时任务, the 技能、连接器、设备… level (with the org's extension
pages), the recent conversations, 全部会话, the account sheet (org switcher, personal settings,
appearance, status, sign out) and 新会话; management pages are not in it. A drawer pick pops its
history entry before it navigates, so one back returns to the page before. `/me` is gone (404),
the PWA starts at `/`, and the design's `BottomNav`, `TopBar` and `MePanel` are removed.
