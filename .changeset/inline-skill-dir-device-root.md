---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

A `/name` skill invocation renders `${CLAUDE_SKILL_DIR}` and its files line under the conversation
device's skills root (`renderSkillInvocation`'s new `skillsRoot`), not always `/skills`; `Skill`
after an inline invocation copies the files without repeating the instructions (#904).
