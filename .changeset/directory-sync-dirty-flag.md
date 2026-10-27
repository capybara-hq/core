---
"@capybara-hq/kernel": patch
---

Directory sync: a sync that finds the lock held writes the dirty flag and then tries the lock once
more. Before, when the holder finished between the failed attempt and the write, the flag was left
for an hour with no follow-up sync, and the next sync skipped its removals
(`changed_during_sync`).
