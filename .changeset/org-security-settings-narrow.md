---
"@capybara-hq/capybara": patch
---

Org security settings fail narrow: an unreadable stored `sandboxToolPolicy` reads as `ask` and an
unreadable scheduled-task `forbiddenTools` list fails unattended runs and refuses new task grants
(both logged with the org id) until an org admin saves it again; the settings page shows a notice
and its Save repairs the list, and unrelated settings writes no longer reset it to empty.
