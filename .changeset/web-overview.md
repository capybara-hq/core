---
"@capybara-hq/web": patch
---

A new overview page. Day to day it shows what waits for you (tool approvals you can allow once in
place, skill changes, catalog requests), the conversations to pick up (marked when one waits for
you), the organization at a glance (agents, skills, connectors, members, available models, your
role) and your most used agents with a Chat button. Until a model and an agent exist it shows the
setup checklist instead, with what can wait (invite members, connect a channel, install plugins).
The design system gains `ItemList`, `StepList` and `Grid columns="main-side"`.
