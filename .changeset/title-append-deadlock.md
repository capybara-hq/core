---
"@capybara-hq/kernel": patch
---

The conversation title job appends its usage event before writing the title, so it locks the
conversation row FOR UPDATE first and can no longer deadlock with a concurrent approval request
(or any write that inserts a row referencing the conversation and then appends to it).
