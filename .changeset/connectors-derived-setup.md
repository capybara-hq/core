---
"@capybara-hq/kernel": patch
---

Connectors report a derived setup state (`setup: "ready" | "needs_config"`): a connector whose auth
needs org input (an OAuth client or an org credential) that is absent is `needs_config`, and it is
never called: credentials refuse it before any token is read or presented, on tool calls, prompts
and resources, drift checks, refresh and the git gateway.
