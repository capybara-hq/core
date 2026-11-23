---
"@capybara-hq/capybara": patch
---

Web: a native form post's same-origin check compares the Origin with the host the CSP names
(a valid `X-Forwarded-Host`, else `Host`), so both agree behind a proxy other than server.mjs.
