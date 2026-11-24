---
"@capybara-hq/kernel": patch
---

Connectors report a derived setup state (`setup: "ready" | "needs_config"`): a connector whose auth
needs org input (an OAuth client or an org credential) that is absent is `needs_config`, and the
tool pipeline refuses to call it before any credential read or connection.
