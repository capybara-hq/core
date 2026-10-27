# Manual skill invocation (package ecosystem phase D)

- Date: 2026-10-27, written against `main` at `e467b1f5` (phases B and C merged) and the UI refresh B
  branch `feat/ui-refresh-b` at `0e11e289` (not merged; its composer, queue and model switch are
  read from the branch).
- Status: reviewed; the maintainer's answers of 2026-10-27 are recorded below and marked
  **(decided, 2026-10-27)** where they apply. Plan:
  `docs/superpowers/plans/2026-10-27-ecosystem-phase-d-manual-skills.md`.
- Parent spec: `2026-10-22-package-ecosystem-design.md` §8.3 (the rows for `commands/`,
  `disable-model-invocation` and `context: fork`), §12 (phase D: "manual skill invocation (a `/`
  menu in the composer); then importing `commands/` and `disable-model-invocation` skills"), §15
  ("the composer's `/` menu is phase D's entry point"), "Phase B as built". Sub-agents:
  `2026-10-26-subagents-design.md`, decision 5 ("Claude skills with `context: fork` wait for phase
  D") and "Phase C as built". Composer: `2026-10-22-ui-refresh-design.md` §5.2, §5.7 and the B plan
  `docs/superpowers/plans/2026-10-26-ui-refresh-b-conversation.md` (on its branch).
- Markers: **(decided)** restates a constraint the maintainer already set in one of those specs;
  **(designer's call)** is decided here on the maintainer's behalf and may be overturned in review.
  Items without a marker restate current code or AGENTS.md rules.
- Written in English (AGENTS.md "Language"). Model-facing text quoted here is the proposed exact
  wording; the builder may polish it, but it stays English and is frozen in the log once written.

## Decisions of 2026-10-27

The maintainer's answers to the first draft's open questions:

1. **Commands are model-invocable too, as in Claude Code** **(decided, 2026-10-27)**, against the
   draft's recommendation (manual-only). A Claude command is translated to an ordinary skill: in the
   model's catalog, loadable with `skill_load`, and listed in the `/` menu. A command (or skill) whose
   source says `disable-model-invocation: true` stays manual-only (§8.2).
2. **After a forked skill, the parent agent answers the report** **(decided, 2026-10-27)** (§6.3).
3. **The `/` menu lists only the agent's selected skills** (its effective skills), not every org
   skill **(decided, 2026-10-27)** (§3.1).
4. **IM invocation is in phase D** **(decided, 2026-10-27)** (§9).
5. **No backfill**: the new frontmatter keys apply from each skill's next version
   **(decided, 2026-10-27)**; the question was not answered, so the recommendation stands (§4.1).

## 0. Summary

A person types `/` in the composer and picks a skill of the conversation's agent, optionally followed
by arguments (`/fix-issue 123`). The kernel resolves the skill at send time, renders its SKILL.md
body with the arguments (Claude Code's `$ARGUMENTS`, `$N`, `$name` substitution, nothing executed),
and writes it into the conversation log as the person's message: a `user_message` whose model-visible
text is the rendered skill and whose new `skill` field says which skill, version and arguments it
was. The model sees exactly what the log holds, so requests reconstruct without a new drift reason,
the same way `@` resource bodies do today.

Claude Code commands (`commands/`) import as ordinary skills, which both the model and the person can
invoke. Two kinds of skill become possible that Capybara could not import before: **manual-only
skills** (`disable-model-invocation: true`, on a skill or a command), which are left out of the
model's skills catalog but listed in the `/` menu; and
**forked skills** (`context: fork`), which, when a person invokes them, run as a sub-agent through
phase C's machinery with the rendered skill as its task, while the parent run waits; the
sub-agent's report goes into the parent log as model-visible text and the parent agent answers.
The `/` menu lists the agent's skills first, then the connector prompts it lists today. IM channels
recognise a leading `/<skill>` in a message the same way they recognise `/new`.

## 1. What has to work (Claude Code, re-checked 2026-10-27)

Source: the docs page "Extend Claude with skills" (`https://code.claude.com/docs/en/skills`;
`/en/slash-commands` serves the same page), reachable and read on 2026-10-27 (the last ~18 % of the
page was not read). Differences from Appendix A of the parent spec are marked **new**.

- **Commands are merged into skills.** "A file at `.claude/commands/deploy.md` and a skill at
  `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way." Command files
  "support the same frontmatter except `name` and `paths`"; a skill and a command with the same name:
  "the skill" wins. Subdirectories of `commands/` become colon namespaces (`frontend/component.md` →
  `/frontend:component`). By default both the person and the model can invoke a command.
- **Frontmatter** (all optional): `name`, `description`, `when_to_use` (**new**, appended to the
  description in the listing), `argument-hint` (autocomplete hint, e.g. `[issue-number]`),
  `arguments` (**new**, named positional arguments for `$name`), `disable-model-invocation`
  ("prevent Claude from automatically loading this skill"), `user-invocable` (`false` hides it from
  the `/` menu), `allowed-tools` (tools usable without asking "during the turn that invokes this
  skill"), `disallowed-tools`, `model` and `effort` (for the current turn), `context: fork` and
  `agent` (the sub-agent type, default `general-purpose`), `background` (**new**: a fork runs in the
  background unless `background: false`), `hooks`, `paths`, `shell`, plus `metadata`, `license`,
  `compatibility`. Unknown fields are ignored.
- **Invocation** `/name args`: `$ARGUMENTS` is the whole argument string; `$ARGUMENTS[N]` and `$N`
  are 0-based positional arguments (shell-like quoting: `"hello world"` is one); `$name` a named
  argument; an indexed placeholder without a value stays unchanged, a named one becomes empty;
  `\$` escapes. "When no placeholder receives an argument, Claude Code appends them as
  `ARGUMENTS: <value>`." `${CLAUDE_SESSION_ID}` and `${CLAUDE_SKILL_DIR}` are substituted.
- **Shell injection**: `` !`command` `` (at the start of a line or after whitespace) and fenced
  ` ```! ` blocks run **before** the content reaches the model and are replaced by their output;
  a failing command aborts the invocation; permission rules apply. `@` file references attach files
  for a local skill.
- **What the model sees**: "the rendered `SKILL.md` content enters the conversation as a single
  message and stays there across later turns." A `disable-model-invocation` skill's description is
  **not** in the model's context. After compaction the latest invocation of each skill is re-attached
  (first 5,000 tokens each, 25,000 in total).
- **`context: fork`**: "Claude Code starts a new subagent of the type set in the `agent` field and
  gives it the skill content as its prompt. The subagent doesn't see your conversation history."
- **Namespaces**: plugin skills are `/plugin-name:skill-name`.

Real plugins (to re-check against the fixtures at plan time): superpowers 7.0.1 has no `commands/`
(phase B's fixture adds the deprecated `commands/brainstorm.md` from 5.0.7, whose 5.x releases also
shipped `write-plan` and `execute-plan`); the official `commit-commands` plugin's commands use
`allowed-tools` and `` !`git status` `` style injections, which is the case §6.4 has to handle.

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. A person invokes any skill of the conversation's agent from the composer's `/` menu, with
  arguments, in a new or an existing conversation (§3, §4).
- G2. Manual-only skills: hidden from the model's catalog, listed in the menu (§5).
- G3. Claude Code `commands/` import as ordinary skills (model and menu) **(decided, 2026-10-27)**;
  skills and commands with `disable-model-invocation: true` import as manual-only; `context: fork`
  skills import (§8) **(decided, §12 of the parent spec)**.
- G4. Forked skills run as a sub-agent when invoked manually, through phase C's dispatch, wait and
  resume (§6) **(decided, sub-agents decision 5)**.
- G5. Everything the model sees is in the log; baseline replay has zero drift; full-run replay never
  starts a sub-agent (§7).
- G6. The same invocation from IM channels (§9) **(decided, 2026-10-27)**.

**Non-goals (phase D)**

- N1. Running shell injections (`` !`cmd` ``, ` ```! `) or expanding `@` file references at
  invocation. They stay text; the model is told how to run them (§4.3).
- N2. Honouring `allowed-tools` (pre-approval), `model` / `effort` (per-turn switch), `hooks`,
  `paths`, `shell` and `when_to_use`. Tool access and policy stay the agent's, the model is the
  agent's or the person's switch (UI refresh B) **(decided, parent spec §8.3 row "ignored
  restrictions")**.
- N3. Background forks (`background` other than `false`). The parent run waits, as for the `agent`
  tool **(decided, sub-agents N3)**; the person can keep typing (messages interject or queue).
- N4. Invoking skills the agent has not selected (all org skills), skills of other agents, or
  connector prompts as skills (they stay what they are today).
- N5. A form per named argument; the arguments are one free-text field after the skill chip.
- N6. A `/` anywhere but at the start of a message; nested commands (`commands/a/b.md`).
- N7. The model invoking a manual-only skill, or invoking a skill "as the user".

**Anti-goals**

- A1. Never execute anything at render time: rendering is a pure string function of the stored
  SKILL.md, the arguments and fixed values.
- A2. Never loosen a policy because a skill asks (`allowed-tools`).
- A3. Never render a skill from the live database at request-building time: the rendered text is
  written into the log when the message is sent.
- A4. Never let the model load a manual-only skill that no person invoked in that conversation.
- A5. Never start a sub-agent during a replay or eval.

## 3. The `/` menu (what the person sees)

### 3.1 Which entries **(decided, 2026-10-27)**

1. **Skills** of the conversation's agent: its **effective skills** as `resolveEffectiveSkills`
   computes them (the selected org skills plus the agent's own skills, including a shared-agent
   trial draft in the conversation that started it), whose version is not `user-invocable: false`.
   Both model-invocable and manual-only skills are listed. Not other org skills: the agent's owner
   chose what this agent does, and a shared agent's members should not be able to add instructions
   the owner did not select.
2. **Connector prompts** (MCP prompts), unchanged from today: `/<connector slug>:<prompt>`, grouped
   by connector, rendered into the composer text and sent as the person's own words.
3. The existing "unavailable connectors" group.

### 3.2 Order, labels and search **(designer's call)**

- One "Skills" group, then one group per connector. Inside "Skills", by name (code point order, as
  the model's catalog); each item reads `/<name>`, then the `argument-hint` when present, then the
  description cut to one line. A skill from a plugin shows the plugin name as a secondary label;
  tags: "manual" for manual-only skills, "sub-agent" for forked ones.
- The palette's search filters as the person types after `/`: matches on the name, on
  `<plugin>:<name>` and on the description; ranking: name prefix, then name substring, then
  description. `/superpowers:brainstorming` finds `brainstorming`.
- Picking a skill turns the start of the composer into a **skill chip** (`/brainstorming`, with the
  `argument-hint` as the placeholder of the text after it); the text after the chip is the
  arguments. Backspace at the start removes the chip and leaves the arguments as text. Files and `@`
  resources can be added as usual.
- **Typed without the menu**: on send, a draft whose text matches `^/([a-z0-9-]+(?::[a-z0-9-]+)?)(\s|$)`
  and names a skill of the loaded list is sent as an invocation of it; anything else (an unknown name,
  `/etc/hosts`) is sent as plain text, as today.
- The list comes from a kernel route (§4.5), loaded when the palette opens, as connector prompts are.

### 3.3 The message in the conversation

- The person's bubble shows the chip and the arguments (from `user_message.skill`), plus files and
  resources as usual, and a collapsed "Skill instructions" disclosure with the rendered text (from
  `content[0]`), so the person can see what was sent in their name.
- A forked invocation additionally shows phase C's sub-agent row under the bubble (status, type,
  calls, duration, `›` to open the child read-only), then a collapsed "Report" block (§6.3), then the
  agent's reply.

## 4. Invocation and the log

### 4.1 Skill metadata **(designer's call)**

The SDK's `parseSkillMd` keeps its result and gains a pure helper
`skillInvocation(frontmatter): SkillInvocation` (strings and booleans only, wrong types reported as
errors by `parseSkillMd`, so a native upload with `disable-model-invocation: "yes"` is refused):

```ts
interface SkillInvocation {
  /** false: `disable-model-invocation: true` (manual-only). */
  model: boolean;
  /** false: `user-invocable: false` (hidden from the menu). */
  user: boolean;
  /** `context: fork`: run as a sub-agent; `agent` as written (resolved at invocation, §6.2). */
  fork?: { agent?: string };
  argumentHint?: string;        // ≤ 200 characters
  arguments?: string[];         // names, each ^[A-Za-z_][A-Za-z0-9_]{0,63}$, ≤ 20
}
```

Capybara's own SKILL.md accepts the same keys, so a native plugin can ship a manual-only or forked
skill. A version's `skill_versions.manifest` (JSON) gains an optional `invocation` copied at upload,
install and `skill_write`; absent means `{ model: true, user: true }`. **No backfill**: a version
uploaded before phase D keeps the default even if its frontmatter has the key (it was imported as an
ordinary skill and agents may rely on it); the next version honours it **(decided, 2026-10-27)**. A skill
with `model: false` and `user: false` is refused at upload (`skill.invalid_package`, "neither the model nor a
person could use this skill").

### 4.2 Arguments and rendering **(designer's call)**

The SDK exports `renderSkillInvocation({ name, body, invocation, args, skillDir })`, a pure function
shared by the kernel, the packer's tests and `capybara-plugin check`:

- `args` is the text after the chip, trimmed, at most 10 000 characters. It is split shell-like
  (double and single quotes group, backslash escapes) into positional values.
- Substitutions, in one left-to-right pass over the body (substituted text is never re-scanned):
  `$ARGUMENTS` → the whole string; `$ARGUMENTS[N]` and `$N` → the N-th value, left unchanged when
  missing; `$name` (only names from `arguments`) → its value, empty when missing; `\$` → `$`;
  `${CLAUDE_SKILL_DIR}` → `/skills/<name>`; `${CLAUDE_SESSION_ID}` and every other `${…}` are left
  as written (phase B's `skill_claude_variables` warning already covers them).
- No placeholder consumed anything and `args` is non-empty: `ARGUMENTS: <args>` is appended after a
  blank line (Claude Code's rule).
- The result is wrapped as in §4.3. `</skill_invocation` inside the body is written
  `<\/skill_invocation`, so the wrapper cannot be closed early (phase B's pinned wrapper has that
  exposure, m5; here the rule exists from the first event).

### 4.3 What the log holds (inline invocation)

`POST …/conversations/:id/messages` (and the first message of `POST /conversations`, UI refresh B)
gains `skill?: { name: string }`; `text` is the arguments. The kernel, in the request:

1. resolves `name` (or `<plugin>:<name>`) among the agent's effective skills **at that moment**
   (the agent's current version, the conversation's trial drafts), refusing a missing or
   `user: false` skill with **400 `skill.not_invocable`** (`details: [{ reason: "not_found" |
   "not_user_invocable" }]`);
2. reads that version's SKILL.md from object storage, checked against the manifest's sha256 (the
   `skill_load` reader), outside any transaction; a storage failure is 503 `storage.unavailable` and
   nothing is written;
3. renders it (§4.2) and appends one `user_message`:

```ts
user_message: {
  content: [ { type: "text", text: <invocation text> }, ...resourceBlocks, ...fileBlocks ],
  attachments?, authorAccountId, clientMessageId?,
  /** New (phase D). Not model-visible; the web renders the chip and arguments from it. */
  skill?: {
    id: string; version: number; source: string; name: string; plugin?: string;
    arguments: string;
    mode: "inline" | "fork";
    /** fork only: the sub-agent type as resolved (§6.2). */
    agentType?: string;
  },
}
```

The invocation text (English, model-visible, exact wording proposed):

```
The user invoked the skill "{name}" with /{name}{ arguments}. Follow its instructions for this request.

<skill_invocation name="{name}" version="{version}">
{rendered body}
</skill_invocation>
```

followed, when they apply, by these lines (each decided at render time and frozen in the text):

- the version has files besides SKILL.md and the agent has `skill_load`:
  `Its files are not in the sandbox yet: call skill_load with "{name}" to copy them to /skills/{name}/ before running its scripts.`
  (without `skill_load`: `Its other files are not available in this conversation.`);
- the body contains shell injections (§1): ``Lines written as !`command` were meant to run before you read this; run those commands with sandbox_bash if you need their output.``
  (only when the agent has `sandbox_bash`; otherwise nothing).

A retry with the same `clientMessageId` returns the written event without resolving again, as for
`@` resources. The message is an ordinary user message from then on: it interjects into a running
run, starts a run when idle, and survives in the history like any other message.

**No new `DriftReason`** **(designer's call)**: the rendered text is the message content; a baseline
reconstructs it byte for byte, and a candidate agent version does not change what a person sent. This
is the existing rule for `@` resource bodies (read with the person's credentials at send time, stored
in `content[i + 1]`, no drift reason). The zero-drift fixtures run before and after (§7).

### 4.4 `skill_load`, the catalog and compaction

- **Catalog**: `resolveSkills` leaves out versions with `invocation.model === false`, so the
  `skills_catalog` snapshot, the catalog text, change reminders and `skill_load`'s name resolution
  never contain a manual-only skill. A skill whose new version turns manual-only reads to the model
  as "removed" in the next change reminder, which is what it is from the model's side. Snapshots
  written before phase D render unchanged.
- **`skill_load` of an invoked manual-only skill**: when the name is not in the snapshot, it is
  resolved from the latest `user_message.skill` of this conversation with that name (id, version,
  source), so the files of a skill the person invoked can be copied into the sandbox (the line of
  §4.3 tells the model to). Any other manual-only name gets the existing "not in the skills catalog"
  text (A4). The tool's spec and description do not change (no spec hash change).
- **Pinned**: a manual-only skill cannot be pinned: `agent.pinned_invalid { reason: "manual_only" }`
  on save; a pinned skill whose new version became manual-only is dropped at run time with
  `log.warn`, as an over-limit one is (phase B ruling 8), and the agent page shows the warning.
- **A model-invoked forked skill** (`context: fork` without `disable-model-invocation`, so it is in
  the catalog): `skill_load` returns the body behind one of these lines **(designer's call)**:
  `This skill is written to run in a sub-agent: call agent with subagent_type "{type}" and a prompt containing these instructions and the details of the task, then use its report; do not follow the instructions yourself.`
  when the agent has the `agent` tool and `{type}` (§6.2) is in its roster, else
  `This skill is written to run in a sub-agent, which is not available here; follow the instructions yourself.`
  The result is logged like any tool result, so replay needs nothing new.
- **Compaction** **(designer's call)**: Claude Code re-attaches invoked skills after compaction. Here
  the restoration after a summary (where `skillsCurrentText` is restored) adds one line when the
  summarised range holds inline invocations:
  `Skills the user invoked earlier in this conversation: {names}. Call skill_load with a name to read its instructions again.`
  It is computed from the log only (the `skill` fields of the covered `user_message`s), so replay
  renders it identically; logs without invocations render exactly as before. Bodies are not
  re-injected: that would be new model-visible input whose size the person never saw.

### 4.5 APIs

- `GET /api/v1/orgs/:orgId/agents/:agentId/invocable-skills?conversationId=` (members who can use the
  agent; with `conversationId`, the owner of that conversation, and trial drafts apply): `{ skills:
  [{ id, name, plugin?, description, version, argumentHint?, arguments?, manual: boolean, fork:
  boolean }] }`, sorted by name. Agent-scoped rather than conversation-scoped because UI refresh B
  creates the conversation on first send.
- `POST …/messages`, `POST /conversations` (`message`), and the queue (`POST …/queue`, UI refresh B)
  accept `skill: { name }`. A queued invocation is rendered **when queued**, like queued `@`
  resources (B's decision 15), and stored with its `skill` metadata.
- Error codes: `skill.not_invocable` (400). `skill.invalid_package` and `agent.pinned_invalid` gain the
  reasons above.

## 5. Manual-only skills

Summary of §4 for one kind: listed in the `/` menu with the "manual" tag; absent from the catalog,
the change reminders and `skill_load` until a person invokes them in the conversation; not pinnable;
otherwise ordinary skills (org skill library, provenance, conflicts, install, upgrade and uninstall
unchanged). The agent page's skill picker shows the tag so the owner knows selecting one adds
nothing to the model's catalog. `skill_write` may write a manual-only skill (its frontmatter decides);
the change approval for shared agents is unchanged.

## 6. Forked skills (`context: fork`)

### 6.1 Shape **(decided: a sub-agent with the skill as its task; details designer's call)**

A person's invocation of a forked skill starts a run of the conversation (as any message does) whose
first act is a phase C dispatch, before any model call; the run waits for the child like a run whose
`agent` call is pending; when the child ends, its report enters the parent log as model-visible text
and the parent's model answers **(decided, 2026-10-27)**.

### 6.2 The sub-agent type and definition

- `agentType`: the skill's `agent` value resolved against the parent agent's roster (§5.1 of the
  sub-agents spec): `general-purpose` (also for an absent value and for Claude's built-in `Explore` /
  `Plan`), an inline template name, `<plugin>:<name>` (a bare `<name>` resolves to the skill's own
  plugin's template first, then by phase C's bare-name rule), or an org agent roster name. A value
  that does not resolve falls back to `general-purpose` and records a warning in
  `subagent_started.warnings` (`Skill "{name}" asked for sub-agent type "{agent}", which this agent does not have; it ran as general-purpose.`).
- The `agent` tool need not be in the agent's tools and `subagents.general: false` does not block
  it **(designer's call)**: the person dispatches, not the model, and a general-purpose child only
  narrows the parent (sub-agents §5.3); the org-agent gates of §5.5 apply unchanged when the type is
  an org agent.
- The effective definition, model resolution, narrowing, preamble, limits and token accounting are
  phase C's, computed at dispatch. `subagent_started.template` gains `invokedSkill?: { id, version,
  name }` (display and eval metadata, not model-visible).
- The child's task `user_message` is the **rendered skill** (§4.2, the same `<skill_invocation>`
  text with the two optional lines), with `dispatch` set as for any child.

### 6.3 Events and the run **(designer's call)**

1. **Send**: the `user_message` with `skill.mode: "fork"` and `agentType`; its model-visible text:
   ```
   The user ran the skill "{name}" in a sub-agent ({agentType}) with /{name}{ arguments}. The sub-agent gets the skill's instructions as its task; its report follows. Do not do the task yourself.
   ```
2. **Run boundary**: the loop never absorbs a fork invocation into a running run (the absorption
   stops before its seq, `absorbedUpToSeq` below it); it starts the next run, as a queued message
   does. Inline invocations interject like any message.
3. **Dispatch**: the run's `prepare` node, before the first model call, finds its trigger message is
   a fork invocation without a `subagent_dispatches` row and dispatches through phase C's
   transaction with `parent_call_id = "skill-<seq>"` (no `tool_call` / `tool_call_started`; no `:`);
   the parent log gets `subagent_dispatched` with `callId: "skill-<seq>"` and a new optional
   `invokedSeq`. Then the run suspends with `waitingFor: { kind: "subagents", id: "sa-<runId>-0" }`;
   waits, resume, timeout, sweeps and the queue are phase C's.
4. **Report**: on resume, `prepare` appends the new model-visible event (idem key
   `skill_fork_result:<seq>`) before the first model step:
   ```ts
   skill_fork_result: { invokedSeq: number; subagentId: string; childRunId: string; text: string }
   ```
   `text` is phase C's tool-result text for the child's end (§4.4 there: final reply, then the
   status line with `agentId`), behind one line:
   `Report from the sub-agent that ran the skill "{name}":`. Request building renders it as user
   content directly after the invocation message (merged into the same user turn).
5. **Stops**: a stop of the parent run while the child works stops the child (phase C's cascade)
   and writes `skill_fork_result` with phase C's stop text, so every fork invocation in a log has its
   report before the next model call; the wait sweep's `sweepOpenAgentCalls` gains the same repair
   for an invocation of a terminal run without a report.
6. The child's approvals and questions go to the person and to the IM thread exactly as phase C's;
   the web's sub-agent list includes the child (it reads `subagent_dispatches`).

## 7. Replay and evals

- **Request building**: `user_message.skill` is not rendered (the content is); `skill_fork_result`
  is rendered as in §6.3; the compaction line of §4.4. Logs written before phase D build
  byte-identically: the zero-drift fixtures (`reconstruct.test.ts`, `rename-compat.test.ts`) pass
  before and after, and `reconstruct.test.ts` gains a conversation with an inline invocation (with
  arguments, files and a later `skill_load`), a fork invocation with its report, and a compaction
  over both, each `model_call` reconstructing with `drift: []`.
- **No new `DriftReason`** (§4.3): invocation text and fork reports are inputs fixed in the log; a
  candidate agent version cannot change them. A candidate that no longer selects the invoked skill
  still replays the recorded message, as a candidate without a connector still replays a recorded
  `@` resource body.
- **Full-run replay** of a run triggered by a fork invocation never dispatches (A5): the
  `RecordedToolPipeline` counterpart for `prepare` returns the recorded `skill_fork_result` text and
  writes no `subagent_*` events; a recording without one (the original run was stopped before the
  report) ends the replayed run as the original ended.
- **Child cases**: a fork child is an ordinary phase C child case (definition and preamble from
  `subagent_started`, `subagent_changed` unchanged); `invokedSkill` is shown in the case metadata.
- The `replay-evals` skill documents the `skill` field, `skill_fork_result`, the compaction line and
  why no drift reason exists.

## 8. Claude Code translation changes (`packages/kernel/src/catalog/claude`)

### 8.1 Report codes

| Claude component | Phase D handling | Report |
|---|---|---|
| skill with `disable-model-invocation: true` | imported; manual-only | `skill_imported` + new `skill_manual_only` (converted) |
| skill with `context: fork` | imported; forked; `agent` kept as written, mapped at invocation | `skill_imported` + new `skill_forked` (converted, `detail.agent`); new warning `skill_agent_unknown` when `agent` names neither `general-purpose` / `Explore` / `Plan` nor an agent of the same plugin |
| skill with both `disable-model-invocation: true` and `user-invocable: false` | not imported | `skill_invalid` (`neither the model nor a person could use this skill`) |
| `commands/*.md`, `commands` paths, `commands` object map (`source` or inline `content`) | imported as ordinary skills: in the model's catalog and the `/` menu (§8.2) | new `command_imported` (imported) |
| a command with `disable-model-invocation: true` | imported as a manual-only skill | `command_imported` + `skill_manual_only` |
| a command whose name is not a valid skill name, or equals a skill of the same plugin, or a nested `commands/a/b.md` | not imported | new `command_invalid` (`detail.problem`; "a skill of this plugin has this name; the skill wins, as in Claude Code") |
| skill or command body with `` !`…` `` or ` ```! ` | imported, text unchanged | new warning `skill_shell_injection` ("runs shell commands when invoked in Claude Code; Capybara gives them to the model as text") |
| `allowed-tools`, `disallowed-tools`, `model`, `effort` on skills and commands | unchanged | `skill_ignored_restrictions` (now also for commands) |
| `argument-hint`, `arguments` | used | — |

`skill_manual_invocation`, `command_manual_invocation` and `skill_needs_subagents` are no longer
emitted and stay in `TranslationCode` for stored reports (as `agent_needs_subagents` did in phase C);
the web's "not supported until phase D" copy goes.

### 8.2 Commands become skills **(decided, 2026-10-27: model-invocable like Claude Code; details designer's call)**

- Each command becomes a skill named after its file (`brainstorm.md` → `brainstorm`) or its key in
  the object map. Its generated `SKILL.md` lives at `.capybara-generated/commands/<name>/SKILL.md`
  (the pattern of phase C's generated agent templates: the source file is never rewritten): frontmatter
  as JSON (valid YAML) with `name`, `description` (the command's, else its first non-empty body line,
  flattened to one line and cut to the skill limit; a command with neither is `command_invalid`
  "no description"), and the command's own `disable-model-invocation`, `user-invocable`,
  `argument-hint`, `arguments`, `context`, `agent`; then the body unchanged. The plugin manifest lists
  the path in `skills`.
- **Model-invocable by default, as in Claude Code** **(decided, 2026-10-27)**: the skill is in the
  model's catalog, loadable with `skill_load` (which returns the stored body: `$ARGUMENTS`
  placeholders stay as written, since the model passes no arguments) and listed in the `/` menu. Only
  a command whose frontmatter says `disable-model-invocation: true` is manual-only.
- The org's skill name rules apply unchanged: a command named like an existing org skill of another
  source fails the org install with `plugin.skill_conflict`, as any skill does.

### 8.3 Re-importing a version imported before phase D **(designer's call)**

The translation changes what an unchanged commit produces (new skills). `claudeContentDigest` folds in
a translator revision `claude-translation-2` **only when** the tree has a command, a manual-only or a
forked skill, so plugins without them keep their digest (no spurious "content changed"), and a
re-import of such a plugin at an already imported version records `<version>+sha256.<12>` through the
existing rule; the review shows the new skills. The marketplace view does not flag it (its
`contentChanged` is commit based, phase B ruling 3); the release note tells admins to re-import
plugins whose report listed commands, manual-only or forked skills.

## 9. IM channels **(decided, 2026-10-27; details designer's call)**

- `channels/inbound.ts` already treats a direct message `/new` as a command. After stripping the bot
  mention, a message whose text matches the §3.2 pattern and names an invocable skill of the bound
  agent (for the bound person) is posted as an invocation with the rest as arguments; anything else
  stays plain text. `/new` stays reserved in direct messages (a skill named `new` cannot be invoked
  there; the web can).
- Inline and forked invocations behave as in the web; a forked child's approvals use phase C's cards;
  the parent's answer is posted to the thread as usual.
- No menu or autocomplete in IM in phase D. Slack's own client treats a message starting with `/` as
  a Slack slash command, so in Slack the invocation works after a mention (`@bot /fix-issue 12`) and
  in a direct message only if the client lets the text through (to be confirmed with the live Slack
  test; registering app slash commands is a later option). Lark passes the text through.

## 10. Web scope (on UI refresh B's composer)

Phase D's web work starts after UI refresh B merges (§12 dependency **(decided)**); it extends B's
`ComposerBar` (`apps/web/src/components/conversation/ComposerBar.tsx` on the branch), built only from
`@capybara-hq/design` (`check:web-ui`):

- the `prompts` palette becomes the `/` palette: the "Skills" group (§3.2) from the new route, then
  B's connector groups; search; tags;
- a design component for the skill chip in `ComposerBox` (with `argument-hint` placeholder and the
  backspace rule), `/dev/ui` fixtures and reference images through `visual-update`;
- typed `/name` recognition on send; the chip in queued messages (B's `QueuedMessage`);
- the user bubble with chip, arguments and the "Skill instructions" disclosure (B's `Disclosure`);
  the fork row (phase C / B's sub-agent components) and the "Report" block;
- the agent page: "manual" / "sub-agent" tags in the skill picker, the `manual_only` pinned refusal;
- the import review and catalog item: the new report codes, the generated command skills;
- i18n (zh and en) for every new text; `check:i18n`.

## 11. Migrations

**None for the kernel's own tables, except the queue** **(designer's call)**: invocation state lives
in the log (`user_message.skill`, `skill_fork_result`) and in JSON that already exists
(`skill_versions.manifest.invocation`, `subagent_dispatched.invokedSeq`, `subagent_started.template.invokedSkill`);
fork dispatches reuse `subagent_dispatches` with `parent_call_id = 'skill-<seq>'`. UI refresh B's
queue table gains `skill jsonb NULL` in one additive file `NNNN_queued_skill.sql`, numbered as the
next free file when it merges (main has `0055`; B's branch carries `0054`–`0058` and renumbers after
phase C, so D's number follows B's). Old replicas never write the column; zero-downtime rules apply.

## 12. SDK, config, docs

- SDK: `SkillInvocation`, `skillInvocation`, `renderSkillInvocation`, `parseSkillMd` type checks for
  the new keys; API report regenerated and a changeset bumping `@capybara-hq/plugin-sdk`
  (`check:sdk-api`, `check:sdk-api-changeset`). `capybara-plugin check` validates the keys.
- No new config. Audit: none (the invocation is a message in the log; a fork dispatch is audited
  `subagent.dispatched` by phase C).
- Skills to update: `writing-plugins` (manual-only and forked skills, commands translation, report
  codes), `writing-tools` (`skill_load` for invoked manual skills and forked skills), `replay-evals`
  (§7), `writing-channels` (§9). AGENTS.md: the tools rule line names manual-only skills and the
  `/` invocation; the runtime line names `user_message.skill` and `skill_fork_result`.

## 13. Tasks (outline for the plan)

| Task | Content | Main files |
|---|---|---|
| D1 SDK | `skillInvocation`, `renderSkillInvocation` (quoting, substitution, escaping), `parseSkillMd` checks; API report; changeset | plugin-sdk `skill.ts`, new `skill-invocation.ts` |
| D2 Skill metadata | `manifest.invocation` at upload, install, upgrade, `skill_write`; catalog leaves out manual-only; pinned `manual_only` | `skills/*.ts`, `catalog/plugin-*.ts`, `skills/catalog.ts`, `agents/*.ts` |
| D3 Invocation API | invocable-skills route; `skill` on messages, first message and queue; resolve, read, render; `user_message.skill`; idempotency; `skill.not_invocable` | `conversations/conversations.service.ts`, new `skills/invoke.ts`, `conversations/queue.ts` (after B) |
| D4 Runtime, inline | `skill_load` resolution from invocations; forked-skill `skill_load` text; compaction line | `tools/builtins/skill-load.ts`, `runtime/context/{build,compaction,skills}.ts` |
| D5 Runtime, fork | run boundary in absorption; dispatch in `prepare`; `skill_fork_result`; stop and sweep pairing; `invokedSeq` / `invokedSkill` | `runtime/langgraph-loop.ts`, `runtime/subagents/*.ts`, `runtime/waits.ts`, `conversations/events.ts` |
| D6 Replay | zero-drift before and after; reconstruct cases; full-run replay of a fork run; child case metadata | `evals/*`, `test/evals/*` |
| D7 Translation | commands → skills; manual and forked skills imported; codes; translator revision in the digest | `catalog/claude/{translate,report,manifest}.ts` |
| D8 IM | inbound parsing; `/new` reserved; fake Slack / Lark tests | `channels/inbound.ts` |
| D9 Web | palette, chip, typed recognition, bubble, fork blocks, agent page, review copy, i18n, references | `packages/design`, `apps/web` |
| D10 Acceptance and docs | §14 tests; skills; AGENTS.md; changesets | `packages/kernel/test/skills/*`, `test/catalog/*` |

D1–D4 and D7 do not need UI refresh B and can merge first (API clients and IM can invoke); D5 needs
phase C only; D3's queue part and D9 wait for B.

## 14. Acceptance

- **Import** (`packages/kernel/test/catalog/claude-import.test.ts`): the `mixed` fixture imports
  `manual` (`skill_manual_only`), `forked` (`skill_forked`) and its command `run` (`command_imported`,
  generated `SKILL.md` under `.capybara-generated/commands/run/`); the superpowers fixture imports the
  command `brainstorm` as an ordinary skill; a fixture command with `` !`git status` `` and
  `allowed-tools` reports `skill_shell_injection` and `skill_ignored_restrictions`; re-importing a
  version imported before D records `+sha256.<12>`.
- **Inline end to end** (new `packages/kernel/test/skills/manual-invocation.e2e.test.ts`, one kernel,
  `model-fake`, fake sandbox): an org installs a fixture Claude plugin with `commands/fix-issue.md`
  (`argument-hint: [issue-number]`, body `Fix GitHub issue $ARGUMENTS …`) and a skill with a
  script and `disable-model-invocation: true`; the agent selects both; the first request's catalog
  text lists `fix-issue` but not the manual skill; the model's `skill_load` of `fix-issue` returns
  the stored body; `/fix-issue 123` puts `Fix GitHub issue 123` inside `<skill_invocation>` in
  the next request; `skill_load` of the manual skill fails before its invocation and copies its files
  after it; a `user: false` skill is 400 `skill.not_invocable`; replaying the conversation
  reconstructs every request with `drift: []`.
- **Fork end to end** (new `packages/kernel/test/subagents/forked-skill.e2e.test.ts`): `/review src`
  on a skill with `context: fork` and `agent: code-reviewer` dispatches `<plugin>:code-reviewer` with
  the rendered body as its task (the child's first request holds only its system text and that task);
  the parent makes no model call until the child ends; `skill_fork_result` precedes the parent's
  reply; an unknown `agent` runs as `general-purpose` with the warning; stopping the parent while the
  child works leaves both aborted and a report with the stop text; a full-run replay of the parent
  sends the same requests and starts no child.
- **Dual replica** (`forked-skill.dual.test.ts`): the invocation posted on A, the child run on B, the
  parent resumed on A; a lost enqueue repaired by the sweep.
- **IM** (fake Lark and Slack): `@bot /fix-issue 7` in a group thread invokes; `/new` in a direct
  message still starts a new conversation; `/unknown` is plain text.
- **Web**: component tests for the palette (order, search, tags), the chip and typed recognition;
  e2e `apps/web/e2e/skills.spec.ts` gains "invoke a manual skill with arguments and see its
  instructions in the bubble"; reference images for the chip and the bubble.
- **Live** (added to the release checklist): import the official `commit-commands` plugin (or another
  Claude plugin with commands, chosen at plan time) and superpowers at a 5.x tag with its commands;
  invoke a command with arguments and a forked skill on a real model with `sandbox-docker`.

## 15. Risks

- **R1 Prompt surface from a person's invocation.** A manual-only skill's body goes into the model's
  context in the person's name. Mitigation: only skills the agent's owner selected are invocable; the
  bubble shows the instructions; the import review already lists the skill bodies.
- **R2 Commands written for coding agents** (git, `gh`, local files) make little sense without a
  repository, and their shell injections do not run. Mitigation: the report warns; the model gets
  the commands as text and the hint to run them; the org chooses which agents get them. Commands
  are model-invocable (decision 1), so a vague command description can trigger a `skill_load` the
  person did not expect; the import review shows each command's description.
- **R3 Forked runs hold a run slot while waiting**: as phase C, a waiting run releases its org slot
  and conversation lock; the token budget and wait timeout bound it.
- **R4 Re-import churn** (§8.3): plugins with commands get a `+sha256` version after D; others keep
  theirs.
- **R5 Slack's slash handling** (§9) may make direct-message invocation impossible without an app
  command; the live test decides whether the docs say "after a mention only".
- **R6 No backfill** (§4.1): an org skill uploaded earlier with `disable-model-invocation: true`
  keeps being model-visible until its next version.

## 16. Left to the builder

The exact model-visible wording within the stated content; the quoting grammar's edge cases (pinned
by tests); the palette's ranking details and limits (how many skills to list before "type to search");
the chip's exact look within the design rules; how the generated command `description` is cut; which
live plugin the checklist uses.

## Open questions for the maintainer

None open. The five questions of the first draft were answered on 2026-10-27 (see "Decisions of
2026-10-27" at the top).
