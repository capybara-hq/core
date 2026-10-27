---
"@capybara-hq/plugin-sdk": patch
---

Skill invocation metadata and rendering (package ecosystem phase D):

- `SkillInvocation` and `skillInvocation(frontmatter)` read a SKILL.md's
  `disable-model-invocation`, `user-invocable`, `context: fork`, `agent`, `argument-hint` and
  `arguments`; `SKILL_INVOCATION_LIMITS`.
- `parseSkillArguments`, `renderSkillBody` and `renderSkillInvocation` render `/name args` with
  Claude Code's `$ARGUMENTS`, `$N`, `$name`, `\$` and `${CLAUDE_SKILL_DIR}` rules (nothing is
  executed); `hasShellInjection` finds `` !`command` `` lines.
- `parseSkillMd` now reports wrong types of those keys, and refuses a skill with both
  `disable-model-invocation: true` and `user-invocable: false`.
