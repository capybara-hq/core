---
"@capybara-hq/kernel": patch
---

The PostgreSQL pool keeps idle connections for `db.idleTimeoutMs` (default 60 s, was pg's 10 s)
with TCP keepalive, so requests after a pause no longer pay a new connection each against a distant
database; long-lived Redis connections probe after 10 s idle and notice a dropped network early.
Conversation titles ask the model for no thinking where it declares the `thinking` knob (a thinking
model spent the 32-token budget on thinking and returned no title), and an empty title is logged.
