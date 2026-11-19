---
"@capybara-hq/kernel": patch
---

A sandbox tool call on a device whose runtime cannot enforce the conversation's permission profile
(for example a restricted profile on a provider that runs Full access only) now tells the model
that nothing ran and to ask for another profile or device, instead of the generic "may not have
completed" failure.
