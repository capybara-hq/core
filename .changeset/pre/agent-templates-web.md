---
"@capybara-hq/web": minor
"@capybara-hq/capybara": minor
---

Agent templates: the 智能体 page has the tabs 智能体 and 模板 and shows both as cards
(`/agent-templates` redirects to `/agents?tab=templates`), the admin 智能体模板 list uses cards too.
A template card and the new template page (`/agents/templates/<id>`: the read view for members, the
editor for org admins) open 用它创建, a dialog with the 带入 / 待配置 / 不可用 preview; the new agent
shows its template and a 待配置 notice in Tools where an admin configures each connector (an existing
one, one more from the template, or the prefilled custom form) and a member sends or repeats a
request. Org admins save an agent as a template from its card or page, and the inbox shows
connector setup requests with the same configure dialog.
