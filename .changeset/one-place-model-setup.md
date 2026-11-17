---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

One place to set up a model: the setup checklist, the run row's fix entry and the models pages lead
to `/admin/models` (super admins: the platform's model services with their deployment config in a
Sheet, and the marketplace's model services not installed yet with 安装) or `/settings/models` (org
admins: the model services offered to the org with 启用 and 配置 inline). While the platform has a
provider the org can turn on or configure (readiness `org_fixable`), the setup step and the page
guide the org admins (a super admin too, when one of them) to Settings → Models instead of the admin
console; members wait for an org admin.
