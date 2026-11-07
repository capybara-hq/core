# Tools are on by default: an agent stores only what is turned off

- Date: 2026-11-08, written against `fix/acceptance` at `fac61342`.
- Status: decided by the maintainer on 2026-11-08 (marked **(decided)**); implemented on
  `fix/acceptance`.
- Related: tool naming (`2026-10-29-tool-naming-claude-code-design.md`, `tools_changed` §9.1),
  org layering (`2026-11-07-platform-org-layering-design.md` §7, the org's per-tool switches of
  PR #89), the `Platform` tool (`2026-11-07-platform-tool-design.md`), agent templates (spec §15
  of `2026-11-05-plugin-component-management-design.md`), sub-agents
  (`2026-10-26-subagents-design.md` §5.3), the replay invariants
  (`.agents/skills/replay-evals/SKILL.md`).
- Markers: **(decided)** is the maintainer's decision; **(designer's call)** is decided here and
  may be overturned in review. Items without a marker restate current code.

## 1. Why

Each agent version stored an explicit list of the tools it uses (`tools: AgentToolRef[]`:
builtins by name, extension tools one by one, connectors with `tools: "all" | names`). A builtin
added later (the `CurrentTime` tool of `fac61342`) therefore never reached an existing agent, and
a connector the org set up needed a second "enable" step on every agent. The maintainer's rule:
**an agent's tools are on by default; the agent stores only what is turned off (decided)**. "If
the org connected it, people want to use it; there is no second enable step." It covers builtin,
extension and connector tools alike.

## 2. Definition shape

`tools` is removed from the agent definition and replaced by `disabledTools` **(decided)**:

```ts
disabledTools: DisabledToolRef[]   // default []

type DisabledToolRef =
  | { kind: "builtin"; name: string }                                        // one builtin
  | { kind: "plugin"; plugin: string; tools: "all" | string[] }              // an extension
  | { kind: "connector"; connectorId: string; tools: "all" | string[] };     // a connector
```

- The entries name tools the way the old refs did, which is how the runtime resolves them: a
  builtin by name, an extension tool by extension name + tool name, a connector tool by connector
  id + tool name. Connector entries use the id, not the slug in the `mcp__<slug>__<tool>` key, so
  renaming a connector never re-enables its tools **(designer's call)**.
- `tools: "all"` turns a whole extension or connector off as one unit, including tools it gains
  later **(decided)**. A list turns off only the named tools; the extension's or connector's other
  tools, and those it gains later, are on.
- Saving normalizes the list: one entry per builtin, extension and connector; an empty name list
  is dropped; names are deduplicated and sorted **(designer's call)**. Builtin names must be
  builtins (`BUILTIN_TOOL_NAMES`), extension entries must name a loaded extension (and its
  registered tools), connector entries a live connector of the org (and tools of its snapshot),
  as the old refs were checked (`validation_failed` at `disabledTools.<i>`).
- `toolPolicies` stays, tighten-only (`ask` / `deny`), keyed by tool key **(decided)**. Its keys
  are checked against every tool the agent could have (all builtins, the tools of the loaded
  extensions, the tools of the org's live connectors in any status), not only the ones on now, so
  a policy on a turned-off tool is kept and applies again when the tool is turned back on
  **(designer's call)**.
- Before 0.1.0 the format changes directly, with no compatibility layer for pre-release state
  (AGENTS.md). History is the one exception, since it is immutable: definitions frozen into logs
  and eval case snapshots (`subagent_started.definition`, `agent_versions` copies in case
  snapshots) still hold `tools`; reading one (`normalizeStoredDefinition`) drops `tools` and reads
  it as "nothing disabled", which is what the migration writes (§3) **(designer's call)**.

## 3. Migration of existing agents and templates

Migration `0089_tools_default_on.sql` **(decided)**:

- every `agent_versions.definition` that has a `tools` key loses it and gets `disabledTools: []`:
  every existing agent (and every older version, so a rollback reads the same shape) has nothing
  turned off;
- every org-made agent template version (`agent_templates` rows with no plugin and no catalog
  item, i.e. saved from an agent by an org admin) loses its `tools` allowlist: the template is
  "nothing disabled" too. Templates that came from plugin packages are left as the package wrote
  them (their content is the plugin's, pinned by its digest) **(designer's call)**.

Template formats (`agents/<name>.md`, the SDK's `AgentTemplate`) do not change: they are Claude
Code's sub-agent format, where an absent `tools` already means "everything the parent has" and
`disallowedTools` is the turned-off list. What a template carries into a new agent
(create-from-template, `planFromTemplate`) **(designer's call)**:

- `disallowedTools` becomes `disabledTools` entries (builtin keys as builtins, extension keys as
  extension tools, connector keys of a bound connector as that connector's tools);
- a `tools` allowlist turns off the **builtins** it does not list (the builtin set is fixed and
  known, so this is exact and a later builtin is still on); it never turns off extension or
  connector tools, which follow the org (§4). `Agent` is kept on when the template describes
  sub-agents (ruling P4-T3-5);
- a `connectors` entry bound to an org connector with a `tools` list turns that connector's other
  tools off; a pending entry, once bound, does the same (`PendingConnectorsService.bind`). The
  `needs` logic (pending entries, the setup request to org admins) is unchanged **(decided)**.

Saving an agent as an org template writes `disallowedTools` (its turned-off builtin and extension
tool keys; a wholly turned-off extension as all its loaded tool keys) and no `tools`; each
connector that is on for the agent becomes a `connectors` entry (with `tools` when some of its
tools are off) **(designer's call)**.

## 4. What an agent has at run time

`ToolRegistry.forAgent` resolves, every step, the universe minus `disabledTools` **(decided)**:

- **builtins:** all of them (`BUILTIN_TOOL_NAMES`), except those the registry manages by rule as
  before (`ToolSearch` by threshold, `Skill` by the skills catalog, `SendMessage` /
  `SubagentHandback` by the agent tree). A builtin that cannot run here (`unavailable()`: no
  sandbox for the sandbox tools, no provider for the web tools) is simply not offered.
  `TaskOutput` / `TaskStop` still come with `Bash`. `Agent` is offered while the roster is not
  empty, which, with `general-purpose` on by default, is every agent that does not turn `Agent`
  off. `SkillWrite` is on for every agent; a shared agent's writes still go through the R3 fixed
  `ask` and the change approval (R4) **(decided: "builtins all")**;
- **extension tools:** every tool registered by an extension that is loaded on this replica and
  enabled in the org, whose effective config for the org is valid **(decided)**. The org admin's
  per-tool switch (PR #89, layering spec §7) still wins: a tool the org turned off is not offered
  to any agent **(decided)**;
- **connector tools:** every enabled tool of every live, active connector of the org whose
  connector extension is installed **(decided)**. Tools that are off, pending review or gone are
  not offered. A per-person credential connector is offered as today: a call without the person's
  credential returns the "needs connection" result and the web shows the connect prompt
  **(decided)**.

Nothing above is a choice of the agent, so the not-offered tools go to `hidden` (used only to
explain a call the model makes by name, spec 6.3), not to `unavailable`: an agent is never told
every step that tools it never asked for are unavailable **(designer's call)**. `unavailable`
keeps only key clashes (two sources with one key).

**Sub-agents** follow the same rule **(decided)**. A child's frozen definition is the parent's (or,
for an org agent child, the org agent's) `disabledTools` plus a key filter
`subagentTools: { allow?: string[]; deny?: string[] }` that only dispatch writes and a save refuses
**(designer's call)**:

- `deny`: `CHILD_REMOVED_TOOLS`, `Agent` at `subagents.maxDepth`, and the template's
  `disallowedTools`;
- `allow`: the template's `tools` allowlist (Claude Code semantics, unchanged: absent = everything
  the parent has; a tool the parent gains later still never slips past an allowlist).
- A follow-up (`resume`) uses the union of the frozen and the current `disabledTools`
  (`user_message.dispatch.narrowed.disabledTools`): it can lose tools, never gain them.

## 5. Many tools

Context cost does not grow with the tool count: the existing `ToolSearch` mechanism takes over
**(decided)**. When the resolved tools exceed `tools.searchThresholdTools` (default **30** tools)
or their estimated definition tokens exceed `tools.searchThresholdTokens` (default **8000**), and
the org setting `toolSearch` is `on` (the default), the request carries full definitions only for
builtins and loaded tools; the rest go into the catalog and the model loads them with
`ToolSearch`. No new threshold is added.

## 6. Shared agents gain tools with the org

A shared agent gains the tools of every connector the org connects and every extension the org
enables, without anyone editing the agent **(decided)**. Policies still apply: the tool's default
policy (from annotations or the connector admin's setting), the org's sandbox policy, the agent's
`toolPolicies`, the R3 fixed list and remembered grants work as before; a tool needing approval
still asks every person who uses the shared agent. An owner who does not want a new tool turns it
off (§8).

## 7. Replay

Nothing changes in the replay invariant **(decided)**:

- each `model_call` already logs the resolved tools (`request.tools` and `catalog`, keys and spec
  hashes); replay and evals read those, never the definition, so old logs replay with zero drift;
- when the resolved set changes between steps (a connector connected, a builtin added) the run
  logs `tools_changed` and the model is told; that is the desired behaviour now;
- `subagent_changed` compares a child's `disabledTools` and `subagentTools` (the depth-dependent
  `Agent` and the child-removed tools left out, as before);
- the zero-drift fixture tests (`reconstruct.test.ts`, `rename-compat.test.ts`) run before and
  after the change.

## 8. Platform tool

The `Platform` operations take and return the new shape **(decided)**:

- `agents.create` / `agents.update`: `disabledTools` (same `DisabledToolRef` shape) instead of
  `tools`; an agent created without it has nothing turned off. `toolPolicies` unchanged;
- `agents.get`: the definition with `disabledTools`;
- `platform.me`: `tools` is the keys the agent has now (the registry's resolution, as a run sees
  them), `disabledTools` what its definition turns off;
- agent templates: preview and create-from-template report what the template turns off.

The Platform tool's second phase (another session) builds on this shape.

## 9. Web

The agent's Tools section **(decided)**:

- every row's checkbox means on / off, and everything is checked by default; unchecking writes to
  `disabledTools`, checking removes from it;
- builtins: every builtin the agent can switch (web tools only while the org has a provider, or
  when turned off), checked unless disabled;
- extension and connector group rows: the summary reads 「全部开启」 / "All on" or
  「已关闭 N 个」 / "N off" (plus the approval counts); unchecking every tool of a group turns the
  group off as a unit (`tools: "all"`), which the summary shows as 「已关闭全部」 / "All off"
  **(designer's call)**; the Sheet lists the group's tools, all checked unless turned off;
- the new-agent form and the agent template editor work the same way.

## 10. Out of scope

- An org-level default-off list for new tools (an admin wants a tool, but not on every agent):
  the org's per-tool switch covers turning a tool off everywhere.
- Changing the plugin template format.
