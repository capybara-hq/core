---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`GET /api/v1/meta` returns the platform icon URL when one is uploaded, and reports
`features.appSignIn` only when `http.publicUrl` is set.
