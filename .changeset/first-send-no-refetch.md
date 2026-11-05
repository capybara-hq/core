---
"@capybara-hq/web": patch
---

After the first send from a new conversation, `/chat/<id>` no longer reads the row, queue and files
again: the first stream open of a seeded conversation is not treated as a catch-up.
