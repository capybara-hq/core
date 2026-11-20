---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

A Read outside the scope asks as a read: the approval's kind is `read` and its tool key `Read`
(it was recorded as a write under `Write`), and its texts say read. The approval card, the inbox
and IM cards word a command ask in the reader's language from its structured facts (kind, reach,
escalation, rule and the profile now carried on `approval_requested.command.profile`) instead of
showing the kernel's English reason, which stays model-facing.
