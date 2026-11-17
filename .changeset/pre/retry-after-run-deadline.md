---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

Honour a provider's retry-after on the same model for up to 5 minutes (and within the run's
remaining deadline) instead of failing or falling back after 10 seconds.
