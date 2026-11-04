# @capybara-hq/web

## 0.1.0-rc.3

### Minor Changes

- 8881b9a: Tool rows follow the Claude Code display: a builtin by its name (`Bash`, `Read`), a connector or
  extension tool as `<display name> [<tool>]` with the declared title as the tooltip, the key
  argument cut with `…`, and the expanded detail in `IN` / `OUT` blocks. `GET …/conversations/:id/tools`
  returns the parsed local tool name (`tool`) and an extension's plugin display name
  (`source.displayName`); approval views carry the extension and its display name; IM approval cards
  name the tool `<display name> [<tool>]` (no separate `appName`). Approval, inbox, grants, trajectory,
  agent policy and right-panel labels use the same rule; a `Write` that could not be diffed no longer
  shows `+0 −0`.

### Patch Changes

- 8bf0b04: The builtin tools take Claude Code's names: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`,
  `Deliver`, `Skill`, `SkillWrite`, `AskUserQuestion`, `ReadToolOutput`, `ToolSearch` and `Agent`
  (formerly `sandbox_bash` … `sandbox_deliver`, `skill_load`, `skill_write`, `ask_user`,
  `read_tool_output`, `tool_search` and `agent`). Every description, error and system text that names
  a builtin uses the new names; a request recorded before the rename is rebuilt with the old texts,
  so it replays with no drift. Several parameters are renamed as well (see the builtin tool
  parameters changeset).
- 56e83dd: A tool call logged under a release-candidate builtin key (`sandbox_bash`, `skill_load`, ...) that was
  still open when the tool names changed runs as the renamed tool with its parameters translated, and
  its result keeps the logged key. An approval of such a call given after the upgrade lets it run
  without asking again, and an `agent` call whose sub-agent was dispatched before the upgrade gets its
  result when the sub-agent finishes. A call to an old key that the request never offered gets the
  unknown-tool error plus a hint naming the new tool and its parameters.
  `GET …/conversations/:id/tools` answers an old builtin key as its current tool with `aliasOf`, so
  the conversation page shows old `agent` calls as sub-agent rows and old builtin calls with their
  current label.

## 0.1.0-rc.2

No changes in this release.

## 0.1.0-rc.1

No changes in this release.
