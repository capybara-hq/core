---
"@capybara-hq/capybara": patch
---

A process that swallowed an unhandled rejection or uncaught exception now answers `/readyz` with 503
until it is replaced (`/healthz` stays 200), so the orchestrator replaces the broken replica.
