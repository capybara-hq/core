---
"@capybara-hq/kernel": minor
---

Push notification registrations and delivery: the `push_registrations` and `push_preferences`
tables, push tokens sealed with the master keyring (rewrapped by `capybara secrets rewrap`).
Trigger events (approvals, questions, connect requests, run ends, background and sub-agent finishes,
scheduled task runs) owe a push fanout in their own transaction; the fanout resolves recipients when
it runs and owes one delivery per registration. New config `push.previews` (`off` | `titles`).
