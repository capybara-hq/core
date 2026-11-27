---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Marketplace manifest, archive and git downloads retry transient failures (a connection error or HTTP
502 / 503 / 504, three tries with backoff) and their errors name the URL, the upstream status and, for
a connection failure, the `net.httpsProxy` setting (core#886).
