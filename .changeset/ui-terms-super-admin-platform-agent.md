---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

UI terms: the web app reads and sends the kernel's renamed `isSuperAdmin` / `superAdmin` /
`orgCreation: "super_admin"`. Chinese copy says 超级管理员 (was 企业管理员), 平台 for the deployment
layer (平台目录, 已启用 · 平台统一, 平台提供的插件), 自定义市场源 for a non-official marketplace,
智能体 for agent (nav 智能体, 新建智能体, 子智能体, 智能体模板), and the role names 组织所有者 /
组织管理员 / 组织成员 / 访客; English says Super admin, Platform, Custom marketplaces and Org owner /
Org admin / Org member / Guest. The CLI says "super admin" in `capybara admin create | grant |
revoke` output and help (`super admin already exists; skipped`, `super admin created`).
