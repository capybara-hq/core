---
"@capybara-hq/web": patch
---

The agent page's Prompt section edits named `.md` prompt files (add, rename, delete, reorder, with
the joined character and file counts), and Model, Tools, Skills and Sub-agents each save only
their own fields with the version they were edited on, offering a reload when it is stale.
