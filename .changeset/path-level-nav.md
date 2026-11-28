---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

Page heads: the path row now follows navigation. Every page the sidebar reaches directly (its
items, the 更多 menu, 个人设置, the admin console's nav, extension pages it opens), their tabs and
their settings sub-pages draw no path row; pages opened from inside a page keep it
(`PageLevelContext`). An extension page's path starts with its own name instead of 扩展页, a project
opened from 项目 reads `capybara / 项目 / <project>`, and personal pages are named 个人设置
instead of `~`.
