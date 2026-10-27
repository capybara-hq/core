---
"@capybara-hq/kernel": patch
---

Manual skill invocation (package ecosystem phase D):

- A skill version stores its invocation metadata (`skill_versions.manifest.invocation`, only when
  not the default) at upload, catalog install and upgrade, and `skill_write`; versions written
  before phase D keep the defaults (no backfill).
- Manual-only versions (`disable-model-invocation: true`) stay out of the model's skills catalog,
  its change reminders and the pinned skills; pinning one is 400 `agent.pinned_invalid`
  `manual_only`, and a pinned skill whose new version is manual-only is dropped at run start with
  a warning. A skill neither the model nor a person could use is `skill.invalid_package`.
  `skill_write` of a manual-only version removes the skill (and its pinned entry) from the
  conversation's catalog snapshot instead of adding it, and says so in its result; rejecting a draft
  never puts back a manual-only current version. Its description now says the invocation keys of the
  `SKILL.md` entry's frontmatter are kept (a spec hash change: remembered grants lapse once).
- Claude Code imports: commands become ordinary skills (`command_imported`, generated under
  `.capybara-generated/commands/<name>/`), `disable-model-invocation` skills import as manual-only
  (`skill_manual_only`) and `context: fork` skills as forked (`skill_forked`), with the new codes
  `command_invalid`, `skill_shell_injection`, `skill_agent_unknown`, `skill_invocation_key_ignored`
  (an invocation key the strict checks refuse is left out instead of refusing the skill or command;
  a command's `argument-hint: [a] [b]` is read as text) and `skill_file_reference` (`@file`
  references stay text); commands report `skill_claude_variables` too. Catalog install and upgrade
  read stored SKILL.md files leniently and never store an invocation nobody can use. The content
  digest of a plugin with a command, a manual-only or a forked skill folds in
  `claude-translation-2`, so re-import plugins whose report listed them to get the new skills.
- A person invokes a skill of the conversation's agent: `POST …/messages` and the first message of
  `POST /conversations` take `skill: { name }` (a skill name or `<plugin>:<name>`; `text` is the
  arguments and may be empty). The skill is resolved among the agent's effective skills at send
  time, its SKILL.md read and checked against the manifest, rendered with the arguments and logged
  as `content[0]` of the `user_message`, whose new `skill` field (not model-visible) records the
  skill id, version, source, name, plugin, arguments and mode (`inline` / `fork`, with the resolved
  `agentType`). A retry with the same `clientMessageId` returns the written event. Refusals:
  400 `skill.not_invocable` (`not_found` / `not_user_invocable`), 400 `validation_failed` for
  arguments or a rendered skill over the limits, 503 `storage.unavailable` (also
  `skill_unreadable` for a SKILL.md failing its integrity check); nothing is written then.
- A conversation's generated title and an eval case's title read an invocation as typed
  (`/<plugin>:<name> <arguments>`), never the rendered skill. A SKILL.md whose body alone is over
  the rendered limit is 400 `validation_failed` on `skill` ("too large to invoke"), and an
  unreadable SKILL.md at invocation is logged with its skill id, version and source.
- `GET /api/v1/orgs/:orgId/agents/:agentId/invocable-skills?conversationId=` lists the agent's
  skills a person can invoke (with `manual`, `fork`, `argumentHint`, `arguments`, `plugin`).
- `skill_load` loads a manual-only skill a person invoked in the conversation (the version their
  message recorded, while it is still one of the agent's effective skills; otherwise the "removed"
  text), and puts a line before a forked skill's instructions: run it through `agent` with its
  sub-agent type, or follow it yourself when that is not available. Its spec is unchanged.
- After a compaction summary whose range holds inline invocations, the request adds the line
  "Skills the user invoked earlier in this conversation: …" (computed from the log; logs without
  invocations build exactly as before).
