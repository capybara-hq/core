# Tool naming and display aligned with Claude Code

- Date: 2026-10-29, written against `main` at `ae213182`; re-checked 2026-10-30 against `main` at
  `02b9634b` (the Nest kernel refactor, PR #55, merged). The builtins' names and schemas did not
  change in the refactor; they are now assembled by one provider, `BuiltinTools`
  (`tools/builtins/builtin-tools.ts`). Every file this spec names still exists.
- Status: draft for review. Ready to plan (the refactor it waited for has merged); it should land
  before the final 0.1.0 (nothing is released yet beyond release candidates, so no old name is
  kept as an alias for the model).
- Followed by: the employee co-build design (separate spec), whose builder agent and skills use
  the names fixed here.
- Markers: **(decided, 2026-10-29)** is the maintainer's ruling in the discussion of 2026-10-29;
  **(designer's call)** is decided here and may be overturned in review. Items without a marker
  restate current code or AGENTS.md rules.
- Written in English (AGENTS.md "Language"). Model-facing text quoted here is the proposed exact
  wording; the builder may polish it, but it stays English.

## Decisions of 2026-10-29

1. **Builtin tools take Claude Code's names and parameters** **(decided)**. A name describes what
   the tool does, not what carries it: `Edit` edits a file; that a sandbox backs it is the
   kernel's business. Builtins without a Claude Code counterpart get a PascalCase name in the
   same style.
2. **Connector tools are `mcp__<connectorSlug>__<tool>`, for every connector protocol** (MCP and
   OpenAPI alike) **(decided)**. To the model `mcp__` means "a tool of an external service"; the
   protocol is an implementation detail.
3. **Extension tools are `plugin__<plugin>__<tool>`** **(decided)**. The plugin name is the unique
   id: the extension's name must equal it (`plugin-manifest.ts:320`) and the catalog owns it, so
   no separate id is declared.
4. **No `mcp__plugin_<plugin>_<server>__<tool>` family** **(decided)**. MCP servers translated from
   Claude Code plugins become ordinary connectors and follow rule 2.
5. **Display follows the Claude Code VS Code extension** **(decided)** (§7): bold tool name plus
   the description for builtins (Bash: the command in an IN block), `<display name> [<tool>]` plus
   a key-argument preview for connector and extension tools.
6. **Cost is not a constraint**: nothing is released, so old names are replaced, not aliased
   **(decided)**. What must still work is data written by release candidates (§8, §9).
7. **`Skill` takes `args`, as in Claude Code** **(decided)** (§4.4): the skill body is rendered
   with the arguments by phase D's renderer, the same way a person's `/name args` is.
8. **`Write` and `Edit` require the file to have been read first, as in Claude Code**
   **(decided)** (§4.5), and refuse a file changed since it was read.
9. **The brackets show the tool's local name; a declared `title` is the tooltip** **(decided)**
   (§7.1).

## 0. Summary

Every model-visible tool key changes. The 13 builtins become `Bash`, `Read`, `Write`, `Edit`,
`Glob`, `Grep`, `Deliver`, `Skill`, `SkillWrite`, `AskUserQuestion`, `ReadToolOutput`,
`ToolSearch` and `Agent`, and the ones Claude Code has take its parameter names (`file_path`,
`old_string`, `new_string`, `replace_all`, `output_mode`, …). Connector tools gain the `mcp__`
prefix, extension tools the `plugin__` prefix. The key alone now tells where a tool comes from:
no `__` means builtin, `mcp__` a connector, `plugin__` an extension.

Skills and agents written for Claude Code then work without translation, and the Claude Code
tool map shrinks to the few names that still differ (`TodoWrite`, `Task`, `SendMessage`, model
names). The web UI and IM cards show tools the way the Claude Code VS Code extension does.

Logs are never rewritten. Old conversations keep their recorded keys and replay with zero drift;
one legacy map (`tools/legacy-keys.ts`) translates old keys where stored configuration, in-flight
calls and full-run replay meet them.

## 1. Claude Code reference

Sources, read 2026-10-29:

- The tool definitions Claude Code presents to the model in a live session (Bash, Read, Write,
  Edit, Skill, Agent, AskUserQuestion, ToolSearch; MCP tools such as `mcp__pencil__execute`,
  `mcp__claude_ai_Slack__slack_send_message`).
- For Grep and Glob, which that session did not expose: unofficial mirrors of the tools reference.
  **The builder re-checks every parameter against the official tools reference
  (`https://code.claude.com/docs/en/tools-reference`, unreachable while this was written) before
  the plan is final**, and records differences in the plan.
- Two screenshots of the Claude Code VS Code extension (the maintainer's, 2026-10-29) for the
  display.

| Tool | Parameters (Claude Code) |
|---|---|
| Bash | `command` (required), `description`, `timeout` (ms, max 600000), `run_in_background` |
| Read | `file_path` (required), `offset`, `limit` (also `pages` for PDFs); output is `cat -n` style |
| Write | `file_path`, `content` (required) |
| Edit | `file_path`, `old_string`, `new_string` (required), `replace_all` (default false) |
| Glob | `pattern` (required), `path` |
| Grep | `pattern` (required), `path`, `glob`, `output_mode` (`content` / `files_with_matches` (default) / `count`), `-i`, `-n`, `-A`, `-B`, `-C`, `type`, `head_limit` (default 250), `offset`, `multiline` |
| Skill | `skill` (required), `args` |
| AskUserQuestion | `questions[]` of `question`, `header` (≤ 12), `multiSelect`, `options[]` (2–4) of `label`, `description` (`preview` optional) |
| ToolSearch | `query` (required), `max_results` |
| Agent | `description`, `prompt`, `subagent_type`, `model`, … (Claude Code's own extras do not apply) |
| MCP | `mcp__<server>__<tool>`, the server name with characters outside `[A-Za-z0-9_-]` replaced by `_` |

## 2. Goals, non-goals

Goals:

- One naming rule per tool source, visible in the key.
- Builtins callable exactly as a model trained on Claude Code expects: same name, same parameter
  names, same meaning for every parameter we accept.
- Claude Code skills and agent definitions work with no tool translation for the shared tools.
- One display rule across the conversation, approvals, inbox, grants, trajectories and IM cards.
- Release-candidate data (agent definitions, grants, conversations, eval sets) keeps working;
  replays of old recordings stay zero-drift.

Non-goals:

- Claude Code's behavioural rules beyond the parameters, except the read-before-write rule
  (§4.5), which is in scope.
- A model's `Skill` call on a `context: fork` skill: it loads inline as today; only a person's
  invocation forks (phase D).
- `run_in_background` for Bash, Read's `pages`, Grep's `type` and `multiline`: not accepted, and
  the descriptions do not mention them (§4.2).
  `run_in_background` is superseded by `2026-11-05-background-bash-design.md`, which accepts it.
- ripgrep in sandboxes. Grep keeps POSIX extended regular expressions and says so in its
  description.
- Renaming anything that is not a tool key (routes, tables, `plugin_<name>` schemas, events).

## 3. Naming rules

### 3.1 Grammar

| Source | Key | Example |
|---|---|---|
| Builtin | `^[A-Z][A-Za-z]{1,31}$` (PascalCase, no `_`) | `Edit`, `AskUserQuestion` |
| Connector | `mcp__<slug>__<tool>` | `mcp__crm__search_accounts`, `mcp__crm__list_resources` |
| Extension | `plugin__<plugin>__<tool>` | `plugin__todo__write` |

`TOOL_KEY_RE` (`^[a-zA-Z0-9_-]{1,64}$`) and the 64-character limit stay: 64 is the lowest limit
among the providers we support. A key that does not fit is reported, never cut, as today.

Parsing is unambiguous: a key without `__` is a builtin; otherwise the part before the first `__`
is the family (`mcp` / `plugin`), the part before the second `__` the slug or plugin name (slugs
cannot contain `__`, plugin names cannot contain `_`), and the rest the local tool name. One
function owns this, `parseToolKey(key)` in `tools/naming.ts`, returning
`{ kind: "builtin", name } | { kind: "connector", slug, tool } | { kind: "extension", plugin, tool }`
or `null`. `toolKey(prefix, name)` becomes `connectorToolKey(slug, tool)` and
`extensionToolKey(plugin, tool)`; every split on `__` in the kernel and the web goes through
these (inventory: `tools/info.ts`, `approvals.service.ts`, `channels/cards.ts`,
`runtime/subagents/definition.ts` `narrowTools`, `resources.ts`, web `PropertiesSections.tsx`,
`lib/subagents.ts`).

The family prefixes cannot collide with anything: a builtin has no `__`; a connector slug named
`plugin` gives `mcp__plugin__x`, never `plugin__…`. No name needs reserving.

### 3.2 Length

The prefixes cost 5 (`mcp__`) and 8 (`plugin__`) characters.

- Connectors: with the longest slug (24) a remote tool name fits in 33 characters (38 today). A
  longer remote name is reported by the existing drift check (`drift.ts`) and not offered, as
  today. The connector form's slug hint says shorter slugs leave room for longer tool names
  **(designer's call)**.
- Extensions: the plugin name plus the local tool name must fit in 54 characters (the SDK allows
  41 + 40). The SDK limits stay; the kernel already rejects an over-long key at registration
  (`toolKeyIssue`). New: `capybara-plugin check` reports it at pack time when the tool name is a
  literal in `ctx.tools.register` (rule `plugin-tool-key-length`, using the source scanner the
  `perm-hooks` rule uses; a non-literal name is reported as "cannot be confirmed statically")
  **(designer's call)**. The official plugins are checked in the plan; none is known to exceed.

## 4. Builtins

### 4.1 Names

| Today | New | Claude Code counterpart |
|---|---|---|
| `sandbox_bash` | `Bash` | Bash |
| `sandbox_read` | `Read` | Read |
| `sandbox_write` | `Write` | Write |
| `sandbox_edit` | `Edit` | Edit (and MultiEdit) |
| `sandbox_glob` | `Glob` | Glob |
| `sandbox_grep` | `Grep` | Grep |
| `sandbox_deliver` | `Deliver` | none |
| `skill_load` | `Skill` | Skill |
| `skill_write` | `SkillWrite` | none |
| `ask_user` | `AskUserQuestion` | AskUserQuestion |
| `read_tool_output` | `ReadToolOutput` | none |
| `tool_search` | `ToolSearch` | ToolSearch |
| `agent` | `Agent` | Agent (formerly Task) |

Which tools need a sandbox stays as it is (the seven former `sandbox_*`); the code keeps a
`SANDBOX_TOOL_NAMES` list with the new names. Constants (`SKILL_LOAD`, `TOOL_SEARCH`,
`AGENT_TOOL`, `BUILTIN_TOOL_NAMES`, `SANDBOX_ASK_TOOL_NAMES`, `R3_FIXED_ASK_TOOL_KEYS`,
`CHILD_REMOVED_TOOLS`, `DEFAULT_AGENT_TOOLS`, `MATCH_IGNORED_FIELDS`, web `AGENT_TOOL` and
`BUILTIN_TOOLS`) move to one module, `tools/builtin-names.ts`, plain constants (not a provider;
`BuiltinTools` and the tool factories import them, kernel tests import them from `src`); the web
keeps its own copy (it may not import the kernel), checked equal by a kernel test reading the web
file **(designer's call)**. The renamed builtins keep being built in `BuiltinTools`; the new ones
of the co-build spec (`SubmitPlugin`, `PlatformInfo`) are added there too.

### 4.2 Parameters

Every parameter we accept keeps Claude Code's name and meaning; parameters Claude Code has and we
do not accept are listed. `additionalProperties: false` stays, so an unsupported parameter is a
validation error the model can read.

| Tool | Today | New | Not accepted |
|---|---|---|---|
| Bash | `command`, `description` (required), `timeoutSeconds` | `command`, `description` (still required: the row shows it), `timeout` in **milliseconds**, clamped to `sandbox.limits.maxCommandSeconds` (default 7 200 s) | `run_in_background` |
| Read | `path`, `offset`, `limit` | `file_path`, `offset`, `limit`; output format unchanged (already `cat -n` style) | `pages` |
| Write | `path`, `content` | `file_path`, `content` | — |
| Edit | `path`, `oldText`, `newText`, `replaceAll` | `file_path`, `old_string`, `new_string`, `replace_all` | — |
| Glob | `pattern`, `path` | unchanged | — |
| Grep | `pattern`, `path`, `glob`, `ignoreCase`; prints matching lines (≤ 500) | `pattern`, `path`, `glob`, `-i`, `output_mode` (default `files_with_matches`), `-n` (default true in `content` mode), `-A`, `-B`, `-C`, `head_limit` (default 250, 0 = no limit up to the 500-line cap), `offset` | `type`, `multiline` |
| Deliver | `path`, `name` | `file_path`, `name` | n/a |
| Skill | `name` | `skill`, `args` (§4.4) | — |
| SkillWrite | `name`, `description`, `files` | unchanged | n/a |
| AskUserQuestion | already Claude Code's shape | unchanged | `preview` |
| ReadToolOutput | `id`, `offset`, `limit`, `charOffset` | unchanged | n/a |
| ToolSearch | `query`, `limit` | `query`, `max_results` | — |
| Agent | `description`, `prompt`, `subagent_type`, `model` (`inherit` / `fast` / `standard` / `capable`), `resume` | unchanged | Claude Code's model names; the description already maps them |

Grep's new default (`files_with_matches`) changes behaviour on purpose: it is what a model trained
on Claude Code asks for first. Grep is implemented with the sandbox's `grep` (`-l`, `-c`, `-n`,
`-A/-B/-C` are POSIX or supported by GNU and BusyBox grep); the builder confirms both sandbox
images have them.

Bash's `timeout` in milliseconds matches Claude Code; the config stays in seconds and the
description states the deployment maximum in seconds **(designer's call)**.

### 4.3 Model-visible text

Every description, error and system text that names a builtin is rewritten with the new names and
parameters (inventory §4: the sandbox tools cross-reference each other, `skill-write.ts`,
`skill-load.ts`, `tool-search.ts`, `outputs.ts`, `elicitation.ts`, `runtime/context/skills.ts`,
SDK `skill-invocation.ts`). The tool design check (`writing-tools`) runs over the new text.

The unknown-tool error gains one sentence when the called key is a pre-rename key:
`Tool "sandbox_bash" no longer exists; it is now "Bash" (parameters: …).` It names the new
parameters where they changed **(designer's call)**. This is the only place the legacy map is
model-visible, and it is written into the log as the tool result, like any error.

### 4.4 `Skill` with `args` **(decided, 2026-10-29; details designer's call)**

- `args` is an optional string, at most 10 000 characters (phase D's argument limit).
- The returned instructions are the SKILL.md body rendered by the SDK's `renderSkillInvocation`,
  the function a person's `/name args` uses: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name`
  substituted, nothing executed, and the arguments appended as `ARGUMENTS: …` when no placeholder
  received them; the rendered result is limited to 200 000 characters, as in phase D. Without
  `args`, the body is rendered with an empty argument string, as Claude Code does, so a
  placeholder never reaches the model literally.
- The rest of the result is unchanged: the file list, and the files copied read-only to
  `/skills/<name>/`.
- Replay: the rendered text is the tool result, already in the log; no new DriftReason.
- `skill_load` loaded the version pinned for the conversation (or the recorded version after a
  person's invocation); `Skill` does the same.

### 4.5 Read before `Write` and `Edit` **(decided, 2026-10-29; details designer's call)**

Rule, as in Claude Code:

- `Edit` on a file, and `Write` on a file that already exists, fail unless this conversation has
  read the file with `Read` (any range) or written it with `Write` / `Edit`, and the file has not
  changed since.
- Errors (model-visible, English):
  - `File has not been read yet. Read it first before writing to it.`
  - `File has been modified since it was read, either by the user or by another command. Read it
    again before writing to it.`
- `Write` to a path that does not exist needs no read.

How it is decided, from the log only (so any replica can decide it, and nothing lives in process
memory):

- `Read`, `Write` and `Edit` results record the file's state in their display-only
  `tool_result.view` (never sent to the model): `{ path, size, sha256 }` of the content the tool
  read or wrote. For a file larger than `Read`'s byte limit, the digest is of the bytes read and
  `size` is the file's full size.
- Before writing, `Write` and `Edit` find the latest `Read` / `Write` / `Edit` result for the same
  normalized path in this conversation's log and compare its `size` and `sha256` with the content
  they read anyway (`Edit` reads the whole file today; `Write` reads the previous content for its
  diff). No match recorded: "not read yet". Mismatch: "modified since".
- Changes made by `Bash`, the person, another conversation's agent or a sub-agent sharing the
  sandbox are therefore caught by the digest.
- A sub-agent's child conversation has its own log, so a child must read a file itself before
  writing it, as a Claude Code sub-agent must.
- Compaction does not change the log, so the rule survives it. A rebuilt sandbox changes the
  files, so the digest catches that too.
- Results recorded before this change carry no digest: a file read only before the upgrade counts
  as not read (one extra `Read`) **(designer's call)**.
- Full-run replay never executes tools, so the rule does not apply there.

## 5. Connector and extension tools

- Keys change per §3; local names, specs and `connector_tools.name` are unchanged (they never held
  the prefix). Resource tools become `mcp__<slug>__list_resources` / `…__read_resource`.
- `connectors.template_tool_policies` is keyed by local name and does not change.
- `ToolSearch` scoring: `tokenize(key)` drops the family token (`mcp`, `plugin`) so every
  connector or extension key does not gain the same token **(designer's call)**.
- Hooks: `ToolPreHookPayload.toolKey` (and the other hook payloads) carry the new keys. This is a
  behaviour change for an extension that matches keys; the SDK doc comment states the grammar and
  `parseToolKey` is exported from the SDK as a pure function so extensions don't re-implement it
  (SDK API change, changeset bumping `@capybara-hq/plugin-sdk`) **(designer's call)**. The plan
  checks the extensions in `capybara-hq/plugins` for key matching.
- Sub-agent template narrowing (`narrowTools`) matches `mcp__<slug>__` as the connector prefix.

## 6. Claude Code maps

Run-time map (`runtime/context/claude-tools.ts`, `CLAUDE_CODE_TOOL_MAP`) becomes:

```text
Some skills in this conversation were written for Claude Code. Its tools Bash, Read, Write, Edit,
Glob, Grep, Skill, AskUserQuestion, ToolSearch and Agent have the same names here, when they are
in your tools. For the others:
- MultiEdit -> several Edit calls
- TodoWrite -> plugin__todo__write when it is in your tools; otherwise keep the task list in your replies
- Task -> Agent; SendMessage to a sub-agent -> Agent with resume; model names haiku / sonnet / opus -> fast / standard / capable
- TaskOutput, TaskStop -> not available
- Any other tool a skill names (for example WebFetch, WebSearch, NotebookEdit, EnterWorktree) -> not available unless one of your tools does the same job
The sandbox tools exist only when this agent has a sandbox; without them a skill's scripts cannot run. A path such as ${CLAUDE_PLUGIN_ROOT}/skills/<name>/... means /skills/<name>/... after Skill has copied that skill into the sandbox.
```

It is written into `skills_catalog.toolMap` as today, so old snapshots keep their text and replay
from the log.

Import map (`catalog/claude/agents.ts`, `TOOL_MAP`): identity for the shared names, plus
`MultiEdit -> Edit`, `Task -> Agent`, `TodoWrite -> plugin__todo__write`. A Claude agent's
`tools:` entry of the form `mcp__<server>__<tool>` is still dropped and reported (the org's
connector slug is not known at import) **(designer's call)**.

## 7. Display

### 7.1 Rule (from the Claude Code VS Code extension)

| Source | Collapsed row | Expanded |
|---|---|---|
| Builtin | **`<Name>`** in bold, then the description for Bash, else the key argument (Read / Write / Edit: path; Glob / Grep: pattern; Skill: skill; Agent: description) in monospace | `IN`: the command (Bash) or the input; `OUT`: the output preview, folded when long |
| Connector | **`<connector display name> [<tool>]`**, then the key-argument preview in monospace, cut with `…` | same `IN` / `OUT` |
| Extension | **`<plugin display name> [<tool>]`**, then the key-argument preview | same `IN` / `OUT` |

- The tool name of a builtin is shown as is, untranslated, as a proper noun **(designer's call)**.
- `[<tool>]` shows the local tool name, not the declared `title`; the `title` becomes the row's
  tooltip **(decided, 2026-10-29)**.
- Edit keeps its diff and `+added −removed` summary, Read its line range, Bash its exit code and
  timed-out mark (`tool_result.view`): these are what Claude Code shows too, under `OUT`.
- `Agent` calls stay sub-agent rows (`timeline.ts`).

### 7.2 Where

- Design system: `packages/design/src/conversation/tool-row.tsx` (`ToolLabel`, `ToolRow`),
  `tool-copy.ts`, `tool-group.tsx`, fixtures. The change goes through `docs/design/spec.md` (row
  anatomy, states) and the visual baselines (`visual-update`), per `writing-web-ui`.
- `apps/web/src/lib/timeline.ts` stays the one builder; it gets the label parts from
  `GET …/conversations/:id/tools` (`tools/info.ts`), which already returns the connector's display
  name and now also the extension's plugin display name and the parsed local tool name.
- One label function in the web (`lib/tool-label.ts`) for every other surface that shows a tool:
  `ApprovalCard.tsx`, `inbox/page.tsx`, `settings/grants/page.tsx`, `TrajectoryParts.tsx`,
  `AgentForm.tsx` policy labels, `RightArea.tsx`, `lib/subagents.ts`. The raw key stays available
  as secondary text where it is shown today (grants, trajectories) **(designer's call)**.
- IM cards: `channels/cards.ts` `shortToolName` uses `parseToolKey` and renders
  `<display name> [<tool>]` for connector and extension tools, the name for builtins.
- i18n: label keys `builtin.ask_user` etc. are renamed to the new names; hints naming tools are
  rewritten (zh and en).

## 8. Stored data

Logs and immutable recordings are never rewritten (append-only; AGENTS.md "Runtime"). Mutable
state is migrated once. Immutable configuration is read through the legacy map.

### 8.1 The legacy map

`packages/kernel/src/tools/legacy-keys.ts`:

- `LEGACY_BUILTINS`: the 13 old names -> new names, with the parameter renames per tool
  (`path -> file_path`, `oldText -> old_string`, `newText -> new_string`, `replaceAll ->
  replace_all`, `ignoreCase -> -i`, `timeoutSeconds -> timeout` (×1000), `name -> skill`,
  `limit -> max_results`).
- `legacyToolKey(key, scope)`: maps an old key to its new key. Builtins map directly. `<x>__<tool>`
  maps to `mcp__x__tool` when `x` is a connector slug in scope and to `plugin__x__tool` when it is
  an extension name; if both (the old scheme already reported that as a collision) or neither, it
  returns `null` and the caller reports it.
- `legacyToolInput(key, input)`: renames the input fields of an old builtin call.

The map is frozen: it describes the release-candidate names and never grows. `check:terms`
exempts this file (§10).

### 8.2 Mutable state: migrated

One kernel migration (`NNNN_tool_keys_claude_code.sql`) rewrites, inside the transaction:

- `tool_grants.tool_key` and `conversation_tool_grants.tool_key` (builtins by literal map;
  `<slug>__…` joined against `connectors.slug` of the same org; the rest against installed
  extension names).
- Pending `questions.spec->>'toolKey'` and pending `approvals.tool_key` (decided ones are history
  and stay).

Destructive in form (it rewrites values), so it carries the exemption comment and reason
`writing-migrations` requires. Rows it cannot map are left and logged by a startup notice
(`tools.legacy_key_unmapped`); a grant that no longer matches simply stops applying, which is
safe (the person is asked again) **(designer's call)**.

### 8.3 Immutable configuration: normalized on read

Agent versions, agent template versions, catalog manifests and translation reports, staging
manifests and eval candidates are versioned records. They are read through one normalizer, the
way `normalizeToolRef` handled the app -> connector rename (`agents/definition.ts`, `z.preprocess`):

- `agent_versions.definition`: `tools` refs `{kind: "builtin", name}` get the new name;
  `toolPolicies` keys and inline sub-agent templates' `tools` / `disallowedTools` /
  `toolPolicies` go through `legacyToolKey`.
- `agent_template_versions.definition`, `catalog_item_versions.manifest` / `translation`,
  `plugin_import_staging.manifest`: the same for template tool lists.
- `eval_runs.candidate`: the same.

Saving a definition writes new keys only; validation rejects an old key on write
(`tool_not_selected` lists the new name in its message).

## 9. Running conversations

- **Conversations started before the upgrade** continue with the new tool list. Their history
  keeps the old `tool_call` names (append-only). The next request sends that history as logged and
  the new tools; providers accept history tool names absent from the current tool list, but the
  acceptance run confirms it for every bundled provider dialect with model-fake and the live tests
  (§13). A model that calls an old name gets the error of §4.3 and corrects itself.
- **Calls in flight across the upgrade** (waiting for approval, `InputRequired`, sub-agent waits):
  the pipeline executes a logged call whose key is not in the current set by resolving it through
  `legacyToolKey` and `legacyToolInput`. Only calls already in the log take this path; a new model
  call with an old name gets the error **(designer's call)**.
- Sub-agents: `subagent_started` freezes the child definition with old keys; a child that resumes
  after the upgrade resolves them the same way.

### 9.1 Tool set changes mid-conversation (added 2026-11-07, acceptance)

The tools are resolved on every step, so an extension switched on in the org (web tools, `todo`),
a connector set up or a sub-agent roster added changes the next request's tool list while the
history still holds the model's earlier "I have no such tool". Like Claude Code's system reminder:

- **Event** `tools_changed { step, added, removed }` (tool names as the model sees them, sorted),
  written by the step (`runtime/model-call.ts`, `runtime/context/tool-changes.ts`) after its
  compaction and before its request, when the step's resolved set differs from the set the
  conversation's previous request offered: the last `model_call`'s `tools` plus `catalog` keys
  (with `ToolSearch` the catalog holds the deferred tools), then any `tools_changed` logged after
  it. Never before a conversation's first request (its list is the baseline), never when
  unchanged; a sub-agent's log follows the same rule on its own. Skipped as a baseline: a
  `model_call` without recorded tools (older logs) and one whose tools were left out because its
  model has no tool support. The wrap-up call writes one too (its request still carries the tools).
- **Idempotency**: idem key `tools_changed:<run>:<step>:<hash of the new set>`; a retried step
  finds its own change applied by the rule above and writes nothing.
- **Rendering** (`build.ts`): a `role: "system"` message at its position: "Your tools changed. Now
  available: … No longer available: … Use the current tool list; it replaces anything said earlier
  in this conversation about which tools you have." **Compaction**: a change covered by the summary
  is dropped (the request's tool list is current anyway); the compaction transcript keeps it as a
  `System reminder:` line so the summary does not carry the stale claim forward.
- A tool removed because it is unavailable (connector down, extension off) also gets the existing
  "unavailable in this run" reminder with its reason; the two are not merged.
- **Replay**: the event is in the log, so step replay renders it as recorded (the tool set of a step
  replay is the recorded one, so it never contradicts the request); old logs have none and rebuild
  byte for byte. **No `DriftReason`**: nothing is missing from a log that predates it (the
  `tools_changed` DriftReason is unrelated: a baseline whose rebuilt tool sequence differs from the
  record). A full-run replay seeds the events before the run, including earlier `model_call`s, and
  runs the same step code: it writes a change exactly when the replay's resolved tools differ from
  the seeded previous request (for example a candidate version with other tools).

## 10. Replay and evals

- **Step replay** rebuilds tools from the recorded `model_call.tools` / `catalog` and
  `snapshot.toolSpecs`, so old recordings keep their old keys and specs: no `tools_changed`, no
  `tool_spec_missing`.
- **System text constants.** The skills catalog header, its change notices, the pinned-skills
  header and the tool catalog header name `skill_load` / `tool_search` from code constants, so
  changing them would give old recordings `system_hash` drift. Rule: the renderer chooses the
  wording from the log. When the run's recorded tool set contains the old builtin keys, it renders
  the pre-rename text (kept verbatim in `runtime/context/legacy-text.ts`, frozen); otherwise the
  new text **(designer's call)**. The zero-drift fixtures (`reconstruct.test.ts`,
  `rename-compat.test.ts`) get a pre-rename recording that names every builtin and connector and
  extension keys, and must reconstruct with no drift.
- **Full-run replay** (`RecordedToolPipeline`): the candidate calls new keys against recordings
  holding old keys. Matching normalizes recorded `(toolKey, input)` through the legacy map before
  comparing, so a pre-rename eval case still matches; `MATCH_IGNORED_FIELDS` uses the new name
  (`Bash: ["description"]`). `evals/diff.ts` compares normalized keys. No new `DriftReason`: the
  model sees nothing new, and a legacy match is recorded in the result's detail
  (`legacyKeyMatch: true`) for the viewer **(designer's call)**.
- Hooks never fire in replays, unchanged.

## 11. Checks

- `check:terms` gets rule `terms-tool-key`: the 13 old builtin names as whole words (and the
  `sandbox_` prefix as a tool name) in tracked files, with exemptions listed in the check and their
  reasons: applied migrations, `tools/legacy-keys.ts`, `runtime/context/legacy-text.ts`, the
  pre-rename fixtures, historical specs and plans, synced skills. Proven red first on a fixture.
  Runs in full on PRs (cheap, part of `pnpm check`), like the rest of `check:terms`.
- `plugin-tool-key-length` in `capybara-plugin check` (§3.2): full on PRs (cheap; it scans the
  plugin sources `perm-hooks` already scans).
- A kernel unit test pins every builtin name to the §3.1 builtin grammar and the web copy of the
  names to the kernel's.

## 12. SDK, plugins repository, docs

- SDK: `parseToolKey` and the key grammar exported (pure); hook payload doc comments;
  `skill-invocation.ts` text. Changeset bumping `@capybara-hq/plugin-sdk`; `pnpm gen:sdk-api`.
- `capybara-hq/plugins` (follow-up PR there, after the core release carrying this): tests and
  model-fake scripts that name keys (`tool:sandbox_bash` -> `tool:Bash`, `tool:todo__write` ->
  `tool:plugin__todo__write`), author skills (`writing-tools`, `writing-connectors`,
  `writing-extensions`, …), any extension matching keys in hooks.
- Core docs and skills: AGENTS.md (the Tools bullet and the `sandbox_bash` / `skill_load` /
  `skill_write` mentions), `.agents/skills/writing-tools` (the naming table), `replay-evals`,
  `writing-sandbox-providers`, `writing-connectors`, `writing-extensions`, `writing-plugins`,
  `writing-extension-ui`, `docs/design/spec.md`, `docs/config.md` (config descriptions naming
  tools, regenerated).
- Changesets: kernel, SDK, plugin-tools, model-fake (its README and tests), and
  `@capybara-hq/capybara` (the image).

## 13. Tasks (outline for the plan)

1. Naming core: `parseToolKey`, `connectorToolKey`, `extensionToolKey`, builtin names module;
   every key split and build moved onto them (kernel, SDK export).
2. Builtins: renames, parameter changes (§4.2), Grep modes, descriptions and errors; tool design
   check.
3a. `Skill` `args` (§4.4) and the read-before-write rule with file digests in `tool_result.view`
   (§4.5).
3. Legacy map, unknown-tool hint, in-flight resolution (§8.1, §4.3, §9).
4. Migration of mutable state and read normalizers (§8.2, §8.3).
5. Claude Code maps (§6).
6. Replay: legacy system text, full-run matching, fixtures (§10).
7. Display: design spec and components, timeline, label function, IM cards, i18n; visual
   baselines (§7).
8. Checks (§11).
9. Docs, skills, changesets (§12); then the plugins repository PR.
10. Acceptance (§14).

## 14. Acceptance

- A fresh deployment: every builtin is called by its new name with Claude Code's parameters
  (model-fake scripts), including each Grep `output_mode`.
- `Skill` with and without `args` returns the rendered body; the same skill invoked by a person
  with the same arguments renders the same text.
- `Edit` without a prior `Read` fails with "not read yet"; after `Read`, a `Bash` change to the
  file makes `Edit` fail with "modified since"; after a second `Read` it succeeds; `Write` to a new
  path succeeds without a read. The same on two replicas (the dual-replica harness).
- A release-candidate database (a dump taken from the current rc with conversations, grants,
  agent versions using `toolPolicies`, an inline sub-agent template, an eval set): after upgrade,
  grants apply, agents run, an old conversation continues, a call waiting for approval across the
  upgrade completes, the eval set's full-run replay matches its recordings.
- Zero-drift fixtures pass for pre- and post-rename recordings.
- A Claude Code plugin with a skill that names Bash / Read / Edit / Skill / TodoWrite runs on an
  agent with a sandbox and the todo plugin, with the shorter tool map.
- Live tests for the bundled providers with a history holding old tool names.
- Visual baselines updated; the conversation, approval card, inbox and an IM card show the §7
  labels.

## 15. Risks

- **Providers rejecting history tool names absent from the tool list.** Mitigation: §14 live test;
  fallback (only if one rejects): the request builder declares the old builtin specs as
  unavailable stubs for that conversation, recorded in the log with a DriftReason.
- **Models reaching for parameters we don't accept** (`run_in_background`, `type`). Validation
  errors are readable; descriptions say what is accepted.
- **Grep default change** surprises an existing agent prompt that expects matching lines. Rare on
  an unreleased product; the description states the default.
- **Key length** squeezes long plugin or remote tool names (§3.2): reported, never cut.
- **The legacy map outliving its purpose**: it is frozen and only read; it can be deleted once no
  supported deployment holds release-candidate data (decided at 1.0).

## Open questions for the maintainer

None open. The three questions of the first draft were answered on 2026-10-29 (decisions 7–9).

## As built

Built as one PR in 12 tasks (`git log db29a244..HEAD`).

- Builtin keys and parameters follow Claude Code (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`,
  `Deliver`, `Skill`, `SkillWrite`, `AskUserQuestion`, `ReadToolOutput`, `ToolSearch`, `Agent`;
  `file_path`, `old_string` / `new_string` / `replace_all`, `timeout` in ms, `skill` + `args`,
  `max_results`, the `Grep` modes). Connector keys are `mcp__<slug>__<tool>`, extension keys
  `plugin__<plugin>__<tool>`; the SDK exports `parseToolKey` and friends.
- `Write` / `Edit` read-before-write is decided from the display-only `view.file`
  `{path, size, sha256}` of earlier results (no process memory); `Write` reads up to 10 MB of the old
  file and fails when it cannot be read for a reason other than the file being gone.
- Legacy handling: the frozen map `tools/legacy-keys.ts`; in-flight resolution of old keys from the
  run's own tools with a hint; migration 0063 rewrites stored grants, approvals and questions (an
  unmappable key stays and is counted in one `tools.legacy_key_unmapped` WARN); saving a definition
  with an old key is refused naming the new key. Old recordings replay with zero drift (old texts
  rebuilt; full-run replay reads the recorded side in the new names and reports `legacyKeyMatch`).
- Checks: `terms-tool-key` (old keys only in the exempt places) and `plugin-tool-key-length`
  (`capybara-plugin check`, run by core on model-fake and the fakes).
- Deviations from the first plan: the Claude map is shorter (unchanged names are listed once);
  `MultiEdit` maps to `Edit` and `TodoWrite` to `plugin__todo__write`; approval cards carry
  `toolName` as `<display name> [<tool>]` and no longer set `appName` (connect cards still do);
  rows carry no verb (the group summary still does).
- Not done in core: the follow-up in `capybara-hq/plugins` (tests and model-fake scripts using old
  keys, author skills, card rendering, key-matching hooks), drafted in the SDD folder for the
  maintainer to open; visual baselines (regenerate with `visual-update` after push); the live
  acceptance of §14 (`docs/superpowers/plans/tool-naming-live-acceptance-checklist.md`).
