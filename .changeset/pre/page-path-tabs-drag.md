---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

Page heads: a head whose tabs are routes stands at its first tab's level on every tab, so a tab's
own route (such as the admin 模板, 市场 or 待确认 tabs) no longer shows a path row its sibling tabs
do not (`headPath`). Path segments are now place names (管理后台 / 连接器 / 模板) instead of URL
slugs. In the desktop shell the strip above a first-level page's title drags the window too.
