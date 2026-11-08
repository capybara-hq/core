---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

A person's default environment left behind by a sandbox provider switch is now shown as
「个人环境（Docker 沙箱）」 / "Personal (Docker sandbox)" (the provider's display name, not its
plugin id), and switching back to that provider makes it the default again, with its files,
instead of creating another empty default. Renaming such an environment makes it an ordinary one.

Rolling deploys: replicas older than migration 0096 still rename a demoted default
`Personal (<plugin id>)` instead of marking it; that is accepted before 0.1.0, so don't run old
replicas alongside new ones across this upgrade.
