---
"@capybara-hq/kernel": minor
---

`catalogs.official.enabled` now defaults to `false`: the official catalog is not live yet, so it is never fetched, no refresh failures are logged, and the admin UI shows offline mode. Set `CAPYBARA_CATALOGS__OFFICIAL__ENABLED=true` to turn it on.
