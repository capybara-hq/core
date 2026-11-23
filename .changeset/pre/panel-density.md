---
"@capybara-hq/capybara": patch
"@capybara-hq/design": patch
"@capybara-hq/plugin-client": patch
---

The conversation's properties panel reads more calmly: the Context section lays out labeled rows
(model, device with its mark under it, connectors, last run, total with sub-agents) instead of
dot-joined lines, and the last run no longer repeats the model when it is the current one. A
property section can carry a hint behind an info button with a tooltip (Background tasks' note on
the permissions running work keeps moves there). The right panel can be narrowed to 360 (was 520).
The client API forwards the design system's `Switch` (`checked`, `onChange`, `label`, `disabled`),
with a `role="switch"` stand-in in `@capybara-hq/plugin-client/testing`.
