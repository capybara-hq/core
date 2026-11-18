---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Add explicit startup CAS activation of resolved permission configuration with bounded PostgreSQL
cancellation, idempotent retries and atomic semantic revocation. Ordinary stale restarts cannot replace
active deployment authority. Expose the start-only `--activate-permission-config` operator option.
