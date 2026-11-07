---
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
"@capybara-hq/capybara": minor
---

Workspace platform components: the 技能 page lists the org's own skills and the platform skills offered to the org with their state and the org admin's switch (已启用 · 平台统一 for `all`), a new 智能体模板 page lists agent templates the same way, the plugin detail lists its components with per-component switches, and an installed plugin missing a connector offers 补充配置. The kernel adds `GET /orgs/:orgId/components`, serves a linked skill copy's detail as its platform skill, and names the missing connector templates in the org catalog detail. The agent editor treats linked copy ids as their platform skill or template; the inbox shows decided requests.
