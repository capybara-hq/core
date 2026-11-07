---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

An installed extension that is not loaded now says why: the org extensions API gives its
deployment `status` and a `reason` (`needs_deployment_config`, `pending_approval`, `failed`, ...),
and a plugin not on in the org whose extension cannot run is `unavailable` with the same reason.
The 扩展 and 插件 pages show it (不可用 · 缺少部署配置) with the next step for the viewer's role
(the super admin gets the admin console link). The Platform tool's `plugins.set-enabled` refuses
such a plugin before the card, naming what is missing and the role's next step; `plugins.list` and
`extensions.list` return compact rows with `state` / `reason` / `next`.
