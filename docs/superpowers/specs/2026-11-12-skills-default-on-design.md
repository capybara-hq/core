# Skills are on by default, and skill pinning goes

- Date: 2026-11-12, written against `origin/main` at `31e69c17` (the agent page's grouped skill list
  is on `fix/acceptance` at `0f8f5bb6`, not yet on `main`).
- Status: approved by the maintainer on 2026-11-12 with every recommendation (§13 records the
  answers); implemented by `docs/superpowers/plans/2026-11-12-skills-default-on.md`.
- Related: tools default-on (`2026-11-08-tools-default-on-design.md`, the pattern this follows),
  skill authoring (`2026-11-10-skill-authoring-via-platform-design.md` §5.7: builtin skills in every
  catalog), plugin component management (`2026-11-05-plugin-component-management-design.md` §5
  scope and org switches, §8 and §15 agent templates), sub-agents (`2026-10-26-subagents-design.md`
  §5.3, §5.5), manual skills (`2026-10-27-phase-d-manual-skills-design.md`), the replay invariants
  (`.agents/skills/replay-evals/SKILL.md`), the skill tools (`.agents/skills/writing-tools/SKILL.md`
  "Skill tools"), Claude Code import (`.agents/skills/writing-plugins/SKILL.md`).
- Markers: **(decided)** is a maintainer decision of 2026-11-12; **(designer's call)** is decided
  here and may be overturned in review; **Qn** (§13) were open questions, now decided. Items without a marker restate current code.

## 1. Why

Today an agent's skills are an explicit selection. The agent definition stores
`skills.orgSkills` (ids of org skills, linked copies or platform skills the agent picked one by one)
and `skills.pinned` (up to 3 of them whose `SKILL.md` bodies are injected into every request, at
most 32 KB). Only the skills of builtin plugins come along unselected (skill authoring §5.7,
`builtinSkillIds` in `skills/usable.ts`). So enabling a plugin with ten skills in an org gives no
agent anything until someone ticks ten boxes on every agent, and a skill the plugin adds in its next
version reaches no agent at all. Tools had the same problem and were switched to default-on on
2026-11-08; skills now follow.

Maintainer decisions (2026-11-12):

1. **Skills from plugins enabled in an org are on for every agent by default (decided).** Each agent
   can switch a single skill or a whole plugin's skills off. It is the rule tools already follow:
   every tool the org offers is on unless the agent turns it off (`disabledTools`).
2. **Pinning ("置顶") is removed (decided).** It is not useful. As in Claude Code, an agent sees a
   catalog of skill names with short descriptions and loads what it needs with the `Skill` tool.
   What must always apply goes into the agent's instructions (Claude Code's `CLAUDE.md`; here the
   agent's `instructionFiles` / `instructions`).
3. **Selecting skills one by one is not what people expect (decided).** Enabling a plugin with skills
   makes them available to all agents.
4. **People must be able to see which plugin a skill comes from (decided).**

This changes rule 11 of plugin component management §5 ("an enabled skill … is offered in the org
… it is not forced onto every agent"): for skills, on in the org now means on for every agent that
does not turn it off. Connector templates and agent templates keep rule 11.

## 2. Goals and non-goals

Goals:

- One rule for what an agent's skill catalog holds, computed at run start from the org's state and
  the agent's off-list; no second enable step.
- Turning a plugin's skills off as a unit covers skills it gains later.
- Pinning gone from the definition, the runtime, the web, plugin import and the docs, while every
  old conversation log still reconstructs byte for byte.
- Catalog growth bounded deterministically and recorded in the log.

Non-goals:

- An org-level "default off for agents" list. The org's existing per-component switch (an org admin
  turns a platform skill off in the org) already removes a skill from every agent; same call as
  tools default-on §11.
- Changing how `Skill` loads a skill, manual-only skills, `/name` invocation or forked skills.
- Changing linked-copy version pinning (`skills.pinned_version`, rulings B2 / P2-18). That is a
  different "pinned" (an org copy that keeps its own version) and stays.

## 3. The rule: what an agent's skill catalog holds

At run start (`SkillsCatalogService.record`, unchanged call site) the agent's effective skills are
**(designer's call, implementing decision 1)**:

```
effective(agent) =
    the agent's own skills (scope = agent)
  ∪ the org skills the agent shared (origin_agent_id = agent)
  ∪ usableSkills(org)                    // every skill on in the org (see below)
  − the skills the agent's disabledSkills turns off
```

then, as today: one skill per name (the agent's own, then an org skill or copy, then a platform
skill), trial versions of the conversation overlaid, manual-only versions left out of the model's
catalog, the result sorted by name and cut to the catalog budget (§7).

`usableSkills(org)` is the existing resolver (`skills/usable.ts`), which already is exactly "every
skill on in the org":

- the org's own live org skills (`scope = 'org'`): skills an org admin created with 新建技能, skills
  of plugins the org uploaded, skills shared from an agent and confirmed, promoted skills;
- platform skills on in the org: a platform plugin in scope (`all`, or `named` with the org listed,
  or `optional` switched on), not disabled on the deployment, not switched off by the org's
  component switch; the shadowing rules (an org skill of the same name wins, rule 10) stay.

What can be turned off, by whom:

| Skill | On for an agent by default | The agent can turn it off | Removed everywhere by |
|---|---|---|---|
| Builtin plugin skill (`catalog_items.builtin`, e.g. `skill-guide`) | yes | **no** (decided: builtin skills stay always on) | nobody (fixed) |
| Platform plugin skill on in the org | yes | yes, by skill or whole plugin | org admin's switch, super admin's scope / disable |
| Org-owned plugin skill (an org upload) | yes | yes, by skill or whole plugin | org admin (switch the item off, delete) |
| Org's own skill without a plugin (新建技能, a shared or promoted skill) | **yes (decided, Q1)** | yes, by skill | org admin (delete) |
| The agent's own skill (`scope = agent`) | yes | no: the owner deletes it | the owner |
| An org skill this agent shared (`origin_agent_id`) | yes | no, for the agent that shared it | org admin (delete) |

Why org-owned and shared skills are on by default too (decided, Q1): the maintainer's
reasoning ("if the org enabled it, people want to use it") is about the org's library, not about
where a skill was made. Every path into the org library already has a human gate: an org admin
creates (新建技能) or uploads it, or confirms a share (skill authoring §5.4). A second rule for
"the org's own skills need selecting" would bring back the per-agent ticking the maintainer rejected
and would make the 技能 section mix two semantics. The agent that shared a skill keeps it without a
definition entry, as today, and cannot turn it off (it can only be deleted), so sharing never makes
a skill vanish from the agent it came from.

Sub-agents (§5.3) and org agents dispatched as sub-agents (§5.5) use the same rule; see §6.

## 4. Definition shape

`skills.orgSkills` and `skills.pinned` are removed; a top-level `disabledSkills` mirrors
`disabledTools` **(designer's call)**:

```ts
disabledSkills: DisabledSkillRef[]   // default []

type DisabledSkillRef =
  | { kind: "plugin"; plugin: string; skills: "all" | string[] }  // a plugin's skills, by skill name
  | { kind: "skill"; skillId: string };                            // a skill with no plugin, by id

skills?: { writePolicy?: "allow" | "ask" }   // only writePolicy is left
```

- **Plugin entries** name the catalog item (`UsableSkill.plugin`, the name `<plugin>:<name>` uses)
  and the skills by name. Names, not ids: within an org's usable set skill names are unique (rule
  10), the plugin + name pair is what the model and `/` invocation already use, and ids of plugin
  skills are aliased (a linked org copy keeps its own id while serving the platform skill, a platform
  id, a pinned copy), which the web already has to untangle (`skillAliases`). A skill renamed in a
  plugin update is a new skill and is on, as an extension tool renamed is (tools default-on §2).
- `skills: "all"` turns the whole plugin off, **including skills it gains later (decided)**. A list
  turns off only the named skills.
- **Skill entries** cover skills without a plugin (the org's own, shared, promoted ones), by id: their
  name can change under the same id (the platform components migration renamed clashes to
  `<name>-org`), so an id keeps an owner's choice, as a connector entry uses the connector id. There
  is no "all" for them: a "turn off every future org skill" switch has no counterpart in tools and
  no one asked for it.
- Saving normalizes: one entry per plugin, names deduplicated and sorted, empty lists dropped,
  skill entries deduplicated and sorted. Checks (400 `validation_failed` at `disabledSkills.<i>`):
  a plugin entry names a plugin with at least one skill in the org's usable set, and its names are
  skills of it; a skill entry names a usable skill without a plugin; a builtin plugin, a builtin
  skill, the agent's own skill or a skill it shared is refused ("cannot be turned off"). An entry kept
  unchanged from the current version is not re-checked (the `assertSubagents` pattern, as for
  `disabledTools`), so a plugin switched off in the org or uninstalled never blocks other edits, and
  if it comes back the agent's choice still holds.
- A request carrying `skills.orgSkills` or `skills.pinned` is refused (strict schema), as the old
  `tools` field is.
- History is immutable: definitions frozen into logs (`subagent_started.definition`,
  `user_message.dispatch.narrowed.skills`) and eval case snapshots (`definitions`) keep the old
  fields. `normalizeStoredDefinition` drops `orgSkills` and `pinned` and reads the definition as
  "nothing disabled", which is what the migration writes (§5). Readers that need the old pins (the
  drift checks, §9) read the raw logged value.
- `InlineAgentTemplate.skills` (skill ids, ≤ 3) stays, with a new meaning (§6.1); the save check
  `skill_not_selected` becomes `skill_not_available` (the id is not in the agent's effective skills).

## 5. Migration of existing data

Pre-0.1.0 there is no compatibility layer, but applied migrations are immutable, so this is a new
migration, `0116_skills_default_on.sql` (0114 and 0115 are taken by the parallel network ask line).

**Existing agents switch to default-on (designer's call, following the maintainer's stated
preference).** Every `agent_versions.definition`:

- loses `skills.orgSkills` and `skills.pinned`; `skills` is kept only when it has `writePolicy`;
- gets `disabledSkills: []`;
- every version, not only the current one, so a rollback reads the same shape (tools migration 0092
  did the same).

The alternative, keeping today's behaviour by writing every currently unselected skill into
`disabledSkills`, would freeze the old selection into an off-list nobody wrote, hide future skills of
those plugins only where it guessed "all", and contradict decision 3. With no real users before
0.1.0 nothing is lost: agents gain the org's skills at their next run start, which the log records
as an ordinary "New skills" notice (§9).

Pinned skills' bodies disappear from new requests. An agent that relied on a pinned skill (the
superpowers trial pinned `using-superpowers`) now sees it in the catalog and loads it with `Skill`;
an owner who wants it to apply always writes that into the instructions. The migration does not copy
bodies into instructions: SQL cannot read object storage, and silently growing every agent's
system prompt is the opposite of the decision.

Also in the migration **(designer's call)**:

- org-made agent template versions (no plugin, no catalog item: saved from an agent by an org admin)
  lose `selectedSkills` (§6.2); plugin package templates are left as the package wrote them (their
  content is pinned by the package digest) and the kernel's stored-template reader drops the field;
- `skill_versions.suggest_pinned` and `platform_skill_versions.suggest_pinned` are left in place and
  no longer read or written; dropping them is a later contract step (`writing-migrations`: a
  destructive statement needs its exemption comment, not worth it for two booleans now).

## 6. Sub-agents and agent templates

### 6.1 Sub-agents

- **`general-purpose` and template children** (sub-agents §5.3): the child's frozen definition
  carries the parent's `disabledSkills` (the child sees the parent's catalog, as it saw the parent's
  `orgSkills`). A template's `disallowedSkills` (§6.2) is added to it: narrowing only.
- **A template's `skills`** (Claude Code's sub-agent field; Claude Code preloads their full content
  into the sub-agent) no longer pins. **Decided (Q3):** the dispatch writes
  one English line into the child's preamble, which is logged in `subagent_started` and therefore
  replay-safe: `Before you start, load these skills with Skill: <name>, <name>.` (only the names that
  are in the child's effective catalog; the rest go to `subagent_started.warnings` as today's dropped
  pins do). `general-purpose` gets no line. The 3-skill and 32 KB pin limits go; the template format
  keeps its limit of 3 names.
- **Inline templates** (`subagents.inline[].skills`, ids) mean the same: the skills that child is told
  to load first.
- **Org agents dispatched as children** (§5.5): their own `disabledSkills` (the dispatched agent's
  owner's choice is part of what that agent is), not the parent's.
- **Follow-ups** (`SendMessage` restarting a child): the child uses the union of the frozen and the
  dispatching version's current `disabledSkills`, recorded in `user_message.dispatch.narrowed` as
  `disabledSkills` (it can lose skills, never gain them; the old `skills: { orgSkills, pinned }` stays
  readable for old logs). This replaces "frozen `orgSkills` intersected with the current version".

### 6.2 Agent templates

The SDK template format (`agents/<name>.md`, `AgentTemplate`) **(decided, Q4)**:

- `skills` (≤ 3 names) keeps the Claude Code meaning for sub-agent use (§6.1).
- `selectedSkills` ("further skills the agent uses", P4-1) is **removed**: with default-on there is
  nothing to select. No official plugin uses it (checked in `capybara-hq/plugins` at `050de14`).
- `disallowedSkills` is **added** (additive, ≤ 64 entries): `<plugin>:<name>`, `<plugin>:*` (the
  whole plugin, future skills included) or a bare `<name>` (an org skill without a plugin). It is the
  skills counterpart of Claude Code's `disallowedTools`, which the format already carries, and it is
  what lets "save as template" keep an agent's off-list. The SDK public API changes, so
  `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`.

Create from template (`agents/from-template.ts`, `planFromTemplate`):

- `disallowedSkills` becomes `disabledSkills` (`<plugin>:*` → `{ kind: "plugin", skills: "all" }`;
  names resolved against the org's usable skills; an unresolved name is dropped and reported).
- Every name in `skills` and in the template's sub-agents' `skills` is checked against the org's
  usable skills. Report items become `carried` (on for the new agent) or `unavailable` (`not_found`:
  the org does not have it). The `pinned`, `not_pinned_manual_only` and `not_pinned_too_large`
  reasons go (still readable for stored previews). A missing skill raises no request automatically;
  the member can ask for an `optional` plugin with the existing request flow (component management
  §5.1 item 4).
- Nothing in `skills` turns other skills off: a template never narrows the org's skills except
  through `disallowedSkills`.

Save an agent as an org template (`agents/org-templates.ts`): `disabledSkills` becomes
`disallowedSkills` (a whole plugin as `<plugin>:*`, a skill entry by its current name); the
agent's own skills are reported as `agent_skill` (not in the org library) as today; `selectedSkills`
is no longer written. The template editor (web) edits `disallowedSkills` with the same grouped list
as the agent page (§10).

### 6.3 Scheduled tasks

Unchanged. A scheduled task runs its agent's current version, so it gets that version's effective
skills like any run. The unattended rule for skill-changing Platform operations
(`UNATTENDED_SKILL_OPERATIONS`) is untouched; `agents.update` with `disabledSkills` follows
`agents.update`'s own policy, as `disabledTools` does.

## 7. Catalog size

Default-on makes catalogs grow: an org with superpowers (14 skills), a document plugin and a few
of its own skills already lists 30–50 entries. Today's bounds are a 300-character cut per description
(`CATALOG_DESCRIPTION_MAX_CHARS`) and 1000 entries per snapshot (`SKILLS_CATALOG_MAX`, truncated by
name with a warning). The listing is in the system segment (the first snapshot) and in append-only
notices, not in the `Skill` tool description as in Claude Code, which keeps the cached system prefix
stable; that stays. Claude Code also caps its listing with a character budget and leaves the rest
out; we do the same, but recorded in the log.

**Decided (Q2), delivered as phase 2 right after phase 1:**

- A deployment config field `skills.catalogBudgetChars` (hot; default **16000** characters, about
  4000 tokens; `adding-config`). At snapshot time the entries are ranked (the agent's own skills,
  builtin skills, the org's own skills, then plugin skills; by name within each) and each keeps its
  description while the running total of rendered lines stays within the budget. Entries past it are
  recorded with `nameOnly: true` in the snapshot.
- Rendering stays a pure function of the snapshot: the listing stays sorted by name; name-only
  entries are listed after the others under `More skills (names only; call Skill with the name to
  read one):`. An old snapshot has no `nameOnly`, so it renders byte for byte as before. Because the
  cut is recorded when the snapshot is written, a later change of the config never changes an old
  request, and no `DriftReason` is needed.
- `sameSkills` compares `nameOnly`, so an entry moving across the budget shows as an "Updated skills"
  notice at the next run start, like any catalog change.
- The 1000-entry hard cap stays as the event schema's limit.
- Run start logs `skills.catalog_over_budget` (org, agent, entries, characters) when the cut applies,
  so we can see whether real orgs reach it.

**Later phase, only if measurements ask for it:** a search mode for `Skill` (`{ query }` returning
matching names and descriptions, a logged tool result, the `ToolSearch` pattern), with name-only
entries then dropped from the listing past a second threshold. Not designed further here.

## 8. Removing pinning

Kernel:

- `skills.pinned`, `PINNED_SKILLS_LIMITS`, `assertPinnedSkills` and `agent.pinned_invalid`,
  `pinnedCandidates`, `loadPinnedBodies`, `fitPinned`, the pinned-set re-resolve loop of
  `SkillsCatalogService.record` and its `conflict` / `storage.unavailable` failures
  (`pinnedFailureText`) go. Run start no longer reads object storage for skills at all.
- New snapshots never carry `pinned`. The event schema keeps the optional `pinned` field so old logs
  parse; `EVENT_*` caps for pinned bodies stay for the same reason.
- Request building keeps every pinned **rendering** path (`pinnedSystemText`, `pinnedChangeText`, the
  restore after compaction): they read only the log. The first run after the migration on a
  conversation whose latest snapshot has pins writes a snapshot without them, and the existing notice
  tells the model `Pinned skills removed (their pinned instructions no longer apply): …`. The text is
  computed from the two snapshots at build time, so it must not change, or old reconstructions would
  drift. The skills stay in the catalog, so the model can still load them.
- `toolMap` (the Claude Code tool-name map) is unrelated to pinning and stays.
- `subagent_started.warnings` keeps its shape (the "not loaded first" warnings replace the dropped-pin
  ones).

Plugins and import:

- `plugin.json` `skills[].pinned` is removed from the SDK type and schema; the kernel's reader of
  stored packages strips it before parsing (stored packages are history). No official plugin uses it.
- `pinnedSuggestions` goes from import confirm (`admin-catalog.controller.ts`) and org upload confirm
  (`org-plugin-uploads.schemas.ts`); a body carrying it is refused by the strict schema. The skills
  APIs stop returning `suggestPinned`, `entryBytes` and `tokenEstimate` (only the pinned picker read
  them).
- **Claude Code import, the SessionStart hook (designer's call):** the report item
  `session_start_pin_hint` is replaced by `session_start_hook` (category warnings): "In Claude Code
  this plugin runs a SessionStart hook, which usually adds instructions (often one of its skills) at
  the start of every session. Capybara does not run hooks. The plugin's skills are in every agent's
  catalog; if an agent must always follow what the hook adds, put its gist in the agent's
  instructions." The report's `sessionStart` flag stays for stored reports; `hooks_not_run` is
  unchanged. The web keeps the old message key for stored reports, as it does for
  `skill_manual_invocation`.

Web and design:

- The 置顶 section on the agent page, its picker (`PinnedSkillsPicker`), the "建议置顶" badge, the
  token estimate, `form.pinnedError.*` and the run-start errors `pinned_unavailable` /
  `pinned_conflict` go, in both message files.
- The design package has no pinning component; nothing to remove there. `CheckList` (design spec
  §6.39, on `fix/acceptance`) already has group heads with mixed state and locked rows, which §10
  needs.

Docs: `writing-tools` ("Skill tools": the catalog rule, pinned bullet removed), `replay-evals`
("Pinned skills and the tool map" becomes "Pinned skills in old logs" plus the new
`pinned_changed` rule), `writing-plugins` (import report, `pinnedSuggestions`, `plugin.json`, template
fields), `writing-web-ui` if it names the section, and the plugins repo's `writing-plugins` (template
format). Specs keep their history; this one amends skill authoring §5.7 (builtin skills are now just
the part that cannot be switched off), component management §5 rule 11 (skills) and sub-agents §5.3.

## 9. Replay, evals and zero drift

The replay invariant does not move: everything the model sees about skills is in the
`skills_catalog` snapshots and the notices built from them.

- **A skill appearing because a plugin was enabled** (or a whole org's agents gaining skills through
  the migration): the next run start resolves a different set, writes a new snapshot, and the request
  gets the existing "New skills" notice at its position. It is in the log, so **no new `DriftReason`**;
  a baseline rebuilds it byte for byte. It reaches the model only at the next run start, as today.
- **Step replay with a candidate** keeps C5: the recorded catalog is rendered whatever the
  candidate's `disabledSkills` say, as with `orgSkills` today and with tools. No new reason.
- **`pinned_changed` stays readable and is redefined:** no candidate can pin any more, so for a
  non-baseline reconstruction without `definition_missing` it is set when the snapshot in effect at
  that call has pins (`payload.pinned` non-empty). The request still renders the recorded bodies (a
  step replay never reads storage). This replaces comparing `skills.pinned` of the candidate and the
  original version, whose definitions the migration has rewritten and the normalizer reads without
  pins.
- **`subagent_changed`** compares `disabledSkills` where it compared `orgSkills`, and a logged child
  definition that pinned skills (read raw from `subagent_started`) counts as changed against any
  candidate, for the same reason.
- **Full-run replay** copies the run's snapshot unchanged, as today (old ones with `pinned`).
- **Zero-drift fixtures.** The pinned cases in `reconstruct.test.ts` and
  `claude-superpowers.e2e.test.ts` generate their logs with the current runtime, which will no longer
  pin. Before the change, record a fixture under `test/evals/fixtures/pre-skills-default-on/` (with
  a README naming the commit, never regenerated, like `pre-background-subagents/`): pinned skills, a
  pinned version change mid-conversation, a claude-code skill with the tool map, a compaction, and a
  child with a pinned template skill. Tests: every recorded `model_call` reconstructs with
  `drift: []`; continuing that conversation with the new code writes a snapshot without pins and the
  "Pinned skills removed" notice, and the new calls rebuild with zero drift too.
  `pinned-render.test.ts` (pure rendering) stays. Run both zero-drift groups before and after.

## 10. UI

Agent page, 技能 section **(designer's call, implementing decisions 1, 3, 4)**:

- One grouped list (`SkillGroups` + design `CheckList`): a group per plugin, headed by the plugin's
  display name; a group 「本组织」 for skills without a plugin; a locked group 「内置」 for builtin
  skills (checked, disabled, "内置" tag). A row's checkbox means on / off; every row is checked by
  default. Unchecking writes to `disabledSkills`; checking removes from it.
- The group head is the whole plugin: unchecking it writes `{ kind: "plugin", skills: "all" }` and the
  head then reads 「已关闭全部（含以后新增的）」; checking it clears the entry. Mixed when some skills
  are off (「已关闭 N 个」). Unchecking every row one by one also collapses to `"all"`, as tools do. The
  「本组织」 head toggles its rows individually (no "all" for it, §4).
- The filter (from 8 skills, name and description) stays; the head acts on the shown rows only while
  a filter is active, and then never writes `"all"`.
- The section summary reads 「已开启 N 个技能」 / "N skills on" with the off count. A hint under the
  title: 「组织启用的技能默认对所有智能体开启。需要每次都遵循的内容请写进说明。」.
- The agent's own skills (upload, share, registration policy) stay as their own subsection,
  always on.
- The 新建智能体 form and the agent template editor (`disallowedSkills`) use the same component.
- A plugin the org turned off is not shown; its entry stays in the definition (harmless, §4).

Org 技能 page: every skill already shows 「来自 <插件>」. Add a plugin filter, and on the detail
page the line 「默认对所有智能体开启；N 个智能体关闭了它」 (from the agents' definitions, the
`agentsUsing` reader of §11).

Org 插件 page: switching a plugin with skills off confirms 「它的 N 个技能将从所有智能体中移除」.
Switching it on needs no extra step for agents.

zh copy uses 智能体 and never the Latin word; `pnpm check:i18n`.

## 11. Kernel APIs, Platform tool and "in use"

HTTP (`agents` routes) and the Platform tool use the same shared schemas (parity rule):

- `POST /agents`, `PUT /agents/:id` and `agents.create` / `agents.update`: `disabledSkills` (the
  `DisabledSkillRef` shape) instead of `skills.orgSkills` / `skills.pinned`; an agent created without
  it has every skill on. The operation descriptions say so ("an agent has every skill on in the org
  unless disabledSkills turns it off").
- `agents.get`: the definition with `disabledSkills`.
- `platform.me`: `skills` is the names the agent has now (the resolver's result, as a run sees them,
  each with its `plugin`), `disabledSkills` what its definition turns off; "pinned" goes from its
  description.
- `skills.list` already returns where a skill came from; it also returns `builtin` (as the library
  list does) so an agent can tell what it cannot turn off.
- Agent template operations (preview, create-from-template, save-as-template) report the new items
  of §6.2.
- The org-admin agents list (`admin-agents.ts`) shows the off count instead of `orgSkills`.

"In use" (`definitionRefs` / `agentsUsing` in `catalog/component-state.ts`): for connectors,
default-on made "uses" mean "has it on". For skills that would make every skill used by every agent,
so a plugin update could never remove a skill (removed components that agents use are `kept`).
**Designer's call:** a skill is *used* by an agent only when it is named: in an inline sub-agent
template's `skills` or in a sub-agent template the roster references. Having it on by default is
not use. Previews that take a skill away (scope change, disable, uninstall, a plugin update
removing it) report how many agents have it on as information, and remove it; affected agents lose
it at their next run start with a catalog notice.

## 12. Rollout

- **Phase 0 (before any code):** record the `pre-skills-default-on` fixture (§9) at the current
  `main`.
- **Phase 1, default-on and no pinning (one PR, kernel + SDK + web together, since the API shape
  changes):** definition and migration (§4, §5); the resolver (§3); sub-agents and templates (§6);
  pinning removed (§8); Platform ops and HTTP (§11); the web (§10); docs and skills; the `over_budget`
  log line only. Tests: the definition checks and normalization; the resolver (plugin on / off in the
  org, an org component switch, a builtin skill that cannot be turned off, a whole-plugin off entry
  covering a skill added by a plugin update, the org's own and a shared skill, name ranking);
  migration (`platform-schema-migration`-style test on old rows, versions and org templates);
  sub-agent narrowing and follow-ups; create-from-template and save-as-template round trip; the import
  report item; the web section (`agent-skills.test.tsx`, template editor) and `/dev/ui` catalog
  blocks; `createAgent` of `@capybara-hq/testing` takes `disabledSkills`; the replay tests of §9.
  Changesets: `@capybara-hq/plugin-sdk` (format), `@capybara-hq/capybara` (kernel and web).
- **Phase 2, catalog budget (small follow-up PR):** `skills.catalogBudgetChars`, `nameOnly` in the
  snapshot, rendering, the notices, zero-drift cases (an old snapshot without `nameOnly`; a budget
  change between runs).
- **Phase 3 (only if measured need):** `Skill` search.
- **Later contract step:** drop the `suggest_pinned` columns.

Multi-replica: nothing new. The resolution happens at run start under the existing conversation row
lock; no process state, no timers; the snapshot is the shared record.

## 13. Decisions on the open questions (maintainer, 2026-11-12)

The maintainer approved every recommendation:

- **Q1.** Org-owned and shared skills are on for every agent by default, like plugin skills (§3).
- **Q2.** The catalog budget comes right after phase 1, as phase 2: `skills.catalogBudgetChars`
  (default 16000 characters), entries past it recorded as `nameOnly` in the snapshot (§7). `Skill`
  search only if real orgs reach it.
- **Q3.** A sub-agent template's `skills` become one logged preamble line telling the child to load
  them with `Skill` first; no bodies are preloaded (§6.1).
- **Q4.** The template format drops `selectedSkills` and adds `disallowedSkills` (§6.2).
