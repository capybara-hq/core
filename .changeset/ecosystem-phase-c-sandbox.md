---
"@capybara-hq/plugin-sandbox-docker": patch
"@capybara-hq/plugin-sandbox-e2b": patch
---

The Docker and E2B sandbox plugins declare concurrent exec: commands carry their holder's tag and
`killTagged` kills one holder's commands. Starting a stopped instance tolerates concurrent calls.
When a tagged kill is not possible and the provider falls back to a restart, the commands of the
other holders end too (it is logged).
