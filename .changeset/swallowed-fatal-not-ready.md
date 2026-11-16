---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

A process that swallowed an unhandled rejection or uncaught exception now answers `/readyz` with 503
at once, stops gracefully (the SIGTERM drain) and exits with 1, so any restart policy replaces it
(`/healthz` stays 200).
