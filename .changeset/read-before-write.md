---
"@capybara-hq/kernel": minor
---

`Write` on an existing file and `Edit` now fail unless the conversation has read the file (or wrote it itself) and it has not changed since. The decision comes from the file state each `Read`, `Write` and `Edit` result records in its display-only `view.file`, so every replica decides the same.
