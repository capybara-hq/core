---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A connector template file may say `"defaultEnabled": false`: the template then starts switched
off in every org, even where its plugin is on, until an org admin switches it on, and while off it
creates no connector and needs no org input (no 需要配置). Ignored for a builtin plugin and for a
template the super admin gave its own scope.
