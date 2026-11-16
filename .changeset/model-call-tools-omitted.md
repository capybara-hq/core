---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`model_call.request.toolsOmitted` records that the kernel left a step's tools out because the model
has no tool support; the tool-change notice reads it instead of matching the reminder text.
Pinned skills are gone from request building: `skills_catalog` has no `pinned`, the pinned blocks
and notices are no longer rendered, and the `pinned_changed` drift reason is removed.
