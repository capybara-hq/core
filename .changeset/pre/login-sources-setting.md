---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
---

Login sources (which `identity-source@1` extensions the login page offers, in which order, and
their trusted tenants) are a deployment setting read from PG (`LoginSourcesService`), no longer
the startup keys `auth.loginSources` / `auth.trustedIdentitySources`, which are removed. The
testing package adds `seedLoginSources(db, entries)`.
