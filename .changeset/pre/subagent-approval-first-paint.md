---
"@capybara-hq/web": patch
---

A reload of a conversation paints its sub-agents' decided approvals decided: the approvals and
questions the log names only by id are read before the first paint, and a card whose state is not
read yet draws nothing instead of a pending approval.
