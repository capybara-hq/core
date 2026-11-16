---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`model_call.request.toolsOmitted` records that the kernel left a step's tools out because the model
has no tool support; the tool-change notice reads it instead of matching the reminder text.
