---
"@capybara-hq/plugin-sdk": minor
---

Skill invocation metadata and rendering (package ecosystem phase D):

- `SkillInvocation` and `skillInvocation(frontmatter)` read a SKILL.md's
  `disable-model-invocation`, `user-invocable`, `context: fork`, `agent`, `argument-hint` and
  `arguments`; `SKILL_INVOCATION_LIMITS`.
- `parseSkillArguments`, `renderSkillBody` and `renderSkillInvocation` render `/name args` with
  Claude Code's `$ARGUMENTS`, `$N`, `$name`, `\$` and `${CLAUDE_SKILL_DIR}` rules (nothing is
  executed); `hasShellInjection` finds `` !`command` `` lines; `escapeSkillInvocationTags` makes
  the wrapper tags inert in text that quotes a person's input. The input's `skillName` (the bare
  skill name) names the sandbox directory for `${CLAUDE_SKILL_DIR}` and the files line, never the
  typed `<plugin>:<name>`. A rendered body over `SKILL_INVOCATION_LIMITS.renderedMaxChars`
  (placeholders repeating the arguments) throws a `RangeError` while substituting.
- `parseSkillMd` now reports wrong types of those keys, and refuses a skill with both
  `disable-model-invocation: true` and `user-invocable: false`.
