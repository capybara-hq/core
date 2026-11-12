---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
---

Agent templates turn skills off with `disallowedSkills` (`<plugin>:<name>`, `<plugin>:*` or a bare
`<name>`, at most 64; `isDisallowedSkillRef`) instead of selecting them: `selectedSkills` is
removed. Creating an agent from a template turns those skills off and lists every name in `skills`
as carried or unavailable; saving an agent as an org template writes its off-list.
