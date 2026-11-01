---
"@capybara-hq/web": patch
---

The agent pages (the list, a new agent and an agent) and the skill library (the list and a skill)
are rendered on the server: they paint
complete, with the agent form's models, connectors, skills, sub-agent options and channels, and no
browser read before the first paint.
