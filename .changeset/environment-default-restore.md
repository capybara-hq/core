---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

A person's default environment left behind by a sandbox provider switch is now shown as
「个人环境（Docker 沙箱）」 / "Personal (Docker sandbox)" (the provider's display name, not its
plugin id), and switching back to that provider makes it the default again, with its files,
instead of creating another empty default. Renaming such an environment makes it an ordinary one.
