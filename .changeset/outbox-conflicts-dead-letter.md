---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

An outbox job id reused with different data now fails the caller's transaction in every
environment, and the dead-letter list pages by `(dead_at, id)` with `next` while retry and discard
take the super admin lock.
