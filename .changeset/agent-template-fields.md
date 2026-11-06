---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
---

Agent templates describe a whole agent: `selectedSkills`, `connectors` (a connector template of the
plugin, or a described need), `subagents` (general, template types, inline types), `modelRef`,
`quickActions` and `instructionFiles`, all optional with limits; existing files parse unchanged.
A sub-agent dispatch resolves a template's `selectedSkills` names without pinning them.
