---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

A single-provider extension point (sandbox, object store, secret store, config source) takes one
enabled provider: enabling a second one is refused with 409 `extension.single_provider_enabled`
(disable the current one first), an import or bootstrap preinstall of a second one is installed
disabled and says why, and two left enabled from before load the earliest enabled on every replica
and after every restart (`extension_installs.enabled_at`, migration 0097). The admin console turns
启用 off with a line naming the provider to disable and a link to it.
