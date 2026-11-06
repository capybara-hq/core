---
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

The workspace has no home page any more: the new conversation is the home. `/` redirects to `/chat`,
新会话 is the current nav item there, and sign-in, setup, an org switch, the not-found page and the
path's org scope all go to `/chat`. The sidebar reads 新会话 · 智能体 · 技能 · 连接器 · 更多; 技能 and
连接器 left the 更多 flyout, which keeps 插件, 扩展, 智能体模板, 渠道, 评测与运行 and 组织设置.
