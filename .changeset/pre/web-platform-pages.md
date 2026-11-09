---
"@capybara-hq/web": patch
---

Extensions' `platform.page` views appear in the admin console: a 扩展 group in the admin sidebar
lists them (hidden when there are none), each opens at `/admin/p/<plugin>/<id>` for super admins,
and an extension's detail page lists the interfaces it declared that did not take effect
(未生效的界面), each with its reason.
