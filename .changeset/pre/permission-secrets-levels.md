---
"@capybara-hq/kernel": patch
---

The permission review's 密钥 group names each secret field with its level (`deployment:appSecret`,
`org:appSecret`) like the config group, so a secret declared at both levels is no longer one name
listed twice (which also broke the web list's keys).
