# Sub-agents (package ecosystem phase C)

- Date: 2026-10-26, written against `main` at `77de4ba` (phase B merged; UI refresh B not built).
- Status: built (see "Phase C as built" at the end); was: draft for maintainer review.
  Parent spec: `2026-10-22-package-ecosystem-design.md` §11
  (direction and constraints), §12 (phase C acceptance), "Phase B as built" (pinned skills, the
  tool-name map, the translation report). Display side: `2026-10-22-ui-refresh-design.md` §5.6 and
  §5.9.
- Markers: **(decided)** restates a constraint the maintainer already set (ecosystem spec §11, UI
  refresh §5.6); **(decided, 2026-10-26)** is the maintainer's answer to this spec's first round of
  open questions; **(designer's call)** is decided here on the maintainer's behalf and may be
  overturned in review. Items without a marker restate current code or AGENTS.md rules.
- Revised 2026-10-26 with the maintainer's answers (see "Decisions of 2026-10-26" below): the tool
  is `agent`; follow-ups (`resume`) are in; `context: fork` skills wait for phase D; the limits are
  4 / 50 / 5 M with sub-agent waiting time outside `runtime.maxRunSeconds`; and, against the first
  draft's recommendations, **concurrent commands in a shared sandbox** (§10) and **org agents as
  sub-agents** (§5.5) are both in phase C.
- Written in English (AGENTS.md "Language"). Model-facing text quoted here (tool description, errors,
  the sub-agent preamble) is the proposed exact wording; the builder may polish it, but it stays
  English and passes the `pnpm check` tool-design rules.

## Decisions of 2026-10-26

The maintainer's answers to the first draft's open questions:

1. The tool is named `agent` **(decided, 2026-10-26)** (§4.1).
2. Concurrent commands in a shared sandbox are supported in phase C **(decided, 2026-10-26)**; the
   first draft recommended keeping them serialized. Designed in §10 (shared and exclusive sandbox
   leases, per-holder command tags, `sandbox@1` additions).
3. Follow-ups (`resume`) are in phase C **(decided, 2026-10-26)** (§4.2).
4. Other org agents can be dispatched as sub-agents in phase C **(decided, 2026-10-26)**; the first
   draft recommended not. Designed in §5.5.
5. Claude skills with `context: fork` wait for phase D (manual invocation) **(decided,
   2026-10-26)**; the translation report keeps `skill_needs_subagents`, worded "runs as a sub-agent
   when invoked manually; phase D".
6. Limits per parent run: 4 concurrent, 50 dispatches, 5 M tokens; time spent waiting for sub-agents
   is not counted toward the parent's `runtime.maxRunSeconds` **(decided, 2026-10-26)** (§7.2, §8.2).

Second round (answers to the questions the two new designs raised):

7. `subagents.dispatchable` is opt-in, default false **(decided, 2026-10-26)** (§5.5).
8. No kernel lock for shell commands writing the same file; the `sandbox_bash` and `agent`
   descriptions warn the model **(decided, 2026-10-26)** (§10.4, N10).
9. `sandbox.maxConcurrentCommands` defaults to 6; `1` is today's serialized behavior
   **(decided, 2026-10-26)** (§10.3).

## 0. Summary

A builtin tool `agent` lets an agent hand a task to a **sub-agent**: a fresh agent with its own
context, started as its own run in its own **child conversation**, whose final reply comes back as
the tool result. The parent run suspends while its sub-agents work, exactly like a run waiting for an
approval (state in PG, no waiting in process, any replica resumes it), and several `agent` calls in
one model response run in parallel. Sub-agents come from four places: a copy of the parent itself
(`general-purpose`), templates written inline in the agent definition, **agent templates** installed
from plugins (including Claude Code `agents/*.md` translated on import), and **other agents of the
org** that the parent's owner allowlists and that the person who started the run can use. A
template sub-agent's tools and policies are the parent's, only narrower; an org agent runs with its
own tools, tightened by the parent's policies, never beyond what the starting person could do by
talking to that agent directly. Approvals go to the person who started the conversation and show up
in the parent conversation (and its IM channel). Sub-agents share the parent conversation's sandbox
and can run commands in it **at the same time** (shared leases for commands, exclusive ones for
lifecycle operations). Extension hooks fire for them with the parent named. Everything the child's
model sees is in the child's own event log, so a child step replays like any other step, and a
full-run replay of a parent uses the recorded `agent` results without starting children. Phase C is
accepted when superpowers' `subagent-driven-development` runs a small plan end to end.

## 1. What has to work (requirements from real users of sub-agents)

**superpowers 7.0.x** (read from the installed 7.0.0 skills: `subagent-driven-development`,
`dispatching-parallel-agents`, `requesting-code-review`):

| # | What the skills do | What it needs here |
|---|---|---|
| S1 | "Dispatch a fresh implementer subagent per task"; a dispatch prompt "describes one task, not the session's history" | a child starts with an empty history: only its system text and the prompt |
| S2 | The implementer "returns only status, commits, a one-line test summary, and concerns"; the full report goes to a file | the child's **final reply** is the result; files are shared (same sandbox) |
| S3 | "Multiple dispatch calls in one response = parallel execution. One per response = sequential." (parallel reviewers, parallel debugging) | several `agent` calls in one assistant message run concurrently; the parent continues when all are done |
| S4 | "Never dispatch multiple implementation subagents in parallel (conflicts)" | nothing special: the model decides; parallel children run commands concurrently in the shared sandbox (§10), so conflicts are the skill's concern, as in Claude Code |
| S5 | "Always specify the model explicitly when dispatching a subagent" (cheap / standard / most capable tiers) | a per-dispatch model choice that is not a vendor model id (§4, §5.4) |
| S6 | Fix rounds 1–3 "resume the original implementer … its context is intact"; "if your harness cannot send another message to a live subagent, dispatch a fresh implementer" | a follow-up message to a finished sub-agent (`resume`), optional for correctness (the skill falls back) |
| S7 | "the implementer never dispatches subagents" | depth 1 **(decided)** matches |
| S8 | `bash scripts/task-brief …`, `bash scripts/review-package …`, git commits | the child has the sandbox tools and the skills' files under `/skills/<name>/` |
| S9 | `requesting-code-review` dispatches `superpowers:code-reviewer` (an `agents/*.md` in 5.x; a prompt file in 7.x) | plugin agent templates addressable as `<plugin>:<name>` |
| S10 | "Waiting on dispatched subagents: … child results arrive on their own" (background children) | **not** in phase C (non-goal N3): the parent waits; the skill still works, it just cannot do local work meanwhile |

**Claude Code** (docs page "Create custom subagents", `https://code.claude.com/docs/en/sub-agents`,
reachable and read on 2026-10-26; the end of the page was truncated, so the Agent tool's full input
schema is taken from the tool as Claude Code exposes it today: `description`, `prompt`,
`subagent_type`, optional `model`):

- The tool was renamed `Task` → `Agent` in v2.1.63; `Task` still works as an alias in settings.
- Agent files are Markdown with YAML frontmatter; the body is the system prompt. Required: `name`,
  `description`. Optional: `tools` (allowlist; omitted = inherit), `disallowedTools`, `model`
  (`sonnet` / `opus` / `haiku` / `fable` / a full id / `inherit`), `permissionMode`, `maxTurns`,
  `autoCompactWindow`, `skills` (preloaded, full content injected), `mcpServers`, `hooks`, `memory`,
  `background`, `omitClaudeMd`, `effort`, `isolation: worktree`, `color`, `initialPrompt`,
  `experimental`. **Plugin agents ignore `hooks`, `mcpServers` and `permissionMode`.**
- Model resolution: per-call `model` → frontmatter `model` → env default → the main conversation's.
- A non-fork sub-agent starts fresh (its prompt, the delegation message, preloaded skills); it does
  not get the conversation history. Its final report comes back to the parent; a failed foreground
  run returns partial output.
- Nesting up to 3 levels by default; up to 20 concurrent; foreground blocks the parent and
  permission prompts pass through; background ones surface their prompts in the main session,
  labelled with the sub-agent's name.
- Resuming: each call creates a new instance; `SendMessage` with the agent id continues one.
- Built-in types: `general-purpose` (all tools), `Explore` and `Plan` (read-only, one-shot).

Capybara keeps Claude's input names (`description`, `prompt`, `subagent_type`, `model`) so skills
written for Claude Code and models trained on it need no translation beyond the tool name.

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. A builtin tool that runs a task in a sub-agent and returns its final reply (§4).
- G2. Parallel dispatch, foreground waiting, fresh context per sub-agent, follow-ups (§7, §8),
  with commands of parallel sub-agents running concurrently in the shared sandbox (§10)
  **(decided, 2026-10-26)**.
- G3. Multi-replica safe: the child run is its own queue job, the parent suspends and resumes through
  PG like an approval wait, every crash point has a recovery path (§7, §13) **(decided)**.
- G4. Permissions only narrow; approvals go to the conversation's starter **(decided)** (§9).
- G5. Limits per parent run: dispatch depth 1, concurrency, dispatch count, tokens counted against
  the parent **(decided)** (§8).
- G6. The child's log is the single source of truth for what its model saw; parent and child replay
  without drift (§15).
- G7. Agent templates from Capybara plugins and from Claude Code `agents/*.md`; `model` maps to a
  purpose, never a model id **(decided)** (§5, §16).
- G7a. Other org agents as sub-agents, within what the starting person may use **(decided,
  2026-10-26)** (§5.5).
- G8. Enough web UI to see, open, approve for and stop sub-agents on today's conversation page; the
  full §5.6 design arrives with UI refresh B (§17).
- G9. superpowers' `subagent-driven-development` runs a small plan **(decided, §12 acceptance)**.

**Non-goals (phase C)**

- N1. Nested dispatch (a sub-agent dispatching sub-agents). Depth is 1 **(decided)**.
- N2. Messaging a sub-agent from the UI. Child conversations are read-only for people; they can watch
  and stop **(decided, UI §5.6)**.
- N3. Background sub-agents (the parent keeps working while children run, results arrive later).
  It needs a second resume path into a running parent and a "results arrived" model-visible event;
  later, if asked for **(designer's call)**.
- N5. Sandbox isolation per sub-agent (`isolation: worktree`, a separate sandbox). Sub-agents share
  the parent conversation's sandbox **(decided: shared by default)**; isolation is later (§10).
- N7. Claude skills with `context: fork`: phase D **(decided, 2026-10-26)**.
- N10. Locking files that shell commands write: the kernel serializes its own file tools per path
  (§10.4); two commands writing one file at the same time is the model's concern, as on any shared
  machine.
- N8. Claude agent `hooks`, `mcpServers`, `permissionMode`, `memory`, `isolation`, `background`
  (Claude itself ignores the first three for plugin agents).
- N9. Built-in `Explore` / `Plan` types. A plugin can ship such templates; the kernel ships only
  `general-purpose`.

**Anti-goals**

- A1. Never wait for a child in process (no promise held across a child run, no timers): the parent
  is a `waiting` row and the child's finish resumes it.
- A2. Never let a template loosen anything: no tool, policy, grant or credential the parent lacks.
- A3. Never execute a child during a replay or eval, and never let a child's model see text that is
  not in the child's log.
- A4. Never route a child's approval to anyone but the parent run's approver (the starter, or the
  role escalation the parent would use).
- A5. No vendor model ids in templates or in the tool input.

## 3. Terms

- **Parent run / parent conversation**: the run whose model called `agent`, and its conversation.
- **Sub-agent**: one child conversation, identified by its conversation id, shown to the model as
  `agentId`. It may have several **child runs** (the first dispatch and each `resume`).
- **Dispatch**: one `agent` call that starts a child run (new sub-agent or `resume`).
- **Agent type**: what `subagent_type` names: `general-purpose`, an inline template's name, a
  plugin template's `<plugin>:<name>`, or the roster name the parent's owner gave an org agent.
- **Agent template**: a reusable sub-agent definition (description, instructions, tool narrowing,
  model tier, step limit, preloaded skills). Inline in an agent definition, or an org **agent
  template** installed from a plugin.
- **Org agent sub-agent**: a sub-agent whose definition is another agent of the org (its current
  version at dispatch), §5.5.
- **Effective definition**: the `AgentDefinition` a child run uses, computed at the first dispatch
  from the template (or the dispatched agent's version) and the parent's definition (§5.3, §5.5) and
  frozen in the child's log.
- **Sandbox lease**: a shared (command) or exclusive (lifecycle) hold on a conversation's sandbox
  (§10).

## 4. The tool contract

### 4.1 Name **(decided, 2026-10-26)**

`agent`, a kernel builtin like `ask_user` and `skill_load`, referenced in an agent definition as
`{ kind: "builtin", name: "agent" }`. Builtin keys contain no `__`, so it cannot collide with
extension (`<ext>__<tool>`) or connector (`<slug>__<tool>`) keys. It is always loaded under
`tool_search` (`isAlwaysLoaded`). It is never offered to a child (depth 1).

### 4.2 Input schema

```json
{
  "type": "object",
  "properties": {
    "description": {
      "type": "string", "minLength": 1, "maxLength": 80,
      "description": "A short label for the task (3 to 6 words), shown to the user."
    },
    "prompt": {
      "type": "string", "minLength": 1, "maxLength": 100000,
      "description": "The complete task for the sub-agent. It sees nothing else of this conversation: include every fact, file path and constraint it needs, and say what its final reply must contain."
    },
    "subagent_type": {
      "type": "string", "minLength": 1, "maxLength": 130,
      "description": "Which agent type to run, from the list in this tool's description. Defaults to general-purpose."
    },
    "model": {
      "type": "string", "enum": ["inherit", "fast", "standard", "capable"],
      "description": "Model tier for this sub-agent: fast and cheap for mechanical work, standard for integration and judgment, capable for design and final reviews. Defaults to the agent type's own setting, else your model."
    },
    "resume": {
      "type": "string", "maxLength": 64,
      "description": "The agentId from an earlier result of this tool: sends prompt to that sub-agent as a follow-up, with its earlier context intact. Leave subagent_type and model unset."
    }
  },
  "required": ["description", "prompt"],
  "additionalProperties": false
}
```

Vendor model names are not in the enum (A5). Skills written for Claude Code say `haiku` / `sonnet` /
`opus`; the tool-name map tells the model how they map (§16.5). `resume` (follow-ups) is in phase C
**(decided, 2026-10-26)**: it appends a `user_message` to the sub-agent's own conversation and starts
its next child run (§6.3).

### 4.3 Description (model-visible)

Built per parent agent version at tool resolution time, so its spec hash changes when the roster or a
limit changes (logged per request as today: `model_call.request.tools[].specHash`, definitions in
`tool_specs`; replays read them by hash, so no new drift reason is needed for it):

```
Dispatch a sub-agent: a fresh agent with its own context that works on one task and returns its
final reply as this tool's result. The sub-agent sees only your prompt, not this conversation, so
include everything it needs and say what its final reply must contain. It shares your sandbox files.
You wait until it finishes. To run several at once, call this tool several times in the same
response (at most {maxConcurrent} at a time); their commands run in the sandbox at the same time, so
give parallel sub-agents separate files or directories. Sub-agents cannot dispatch sub-agents or ask
the user questions. To send a finished sub-agent a follow-up while keeping its context, pass the agentId from
its result as resume.

Agent types (subagent_type):
- general-purpose: a copy of you with your tools and skills, for multi-step work.
- {name}: {description}
- {roster name}: {description} (the agent "{agent name}", with its own tools and model)
```

Inline templates are listed by name, plugin templates as `<plugin>:<name>`, org agents by their
roster name and the description the parent's owner wrote for them (§5.5), in the order the owner
chose; each description is cut to 1024 characters and the roster to 20 entries (the agent page
refuses more, §5.2). A plugin template's bare `<name>` is also accepted when no other type in the
roster has it (Claude Code accepts `reviewer` for `my-plugin:reviewer` the same way).

### 4.4 Result

The tool result (`tool_result.content`, model-visible, archived by the usual output spilling when
long) is the child run's **final reply text** (the text blocks of its last `assistant_message`),
followed by one status line:

```
{final reply}

[agentId: {childConversationId} · {status} · {n} tool calls · {duration} · {tokens} tokens. Pass the agentId as resume to send this sub-agent a follow-up.]
```

| Child run ended | `status` | `isError` | Text before the status line |
|---|---|---|---|
| `run_finished { reason: "completed" }` | `completed` | false | the final reply |
| `run_finished { reason: "max_steps" }` (after the wrap-up call) | `stopped at the step limit; the reply may be partial` | false | the wrap-up reply |
| `run_finished { reason: "max_duration" }` | `stopped at the time limit; the reply may be partial` | false | the last reply text, or `The sub-agent produced no reply before the time limit.` |
| stopped because the parent run's sub-agent token budget ran out (§8.3) | `stopped: token budget used up` | true | the last reply text, if any |
| `run_aborted` by a person | `stopped by the user` | true | `The user stopped this sub-agent.` |
| `run_aborted` by the parent's stop (only seen in logs; the parent is terminal) | — | true | `The run was stopped while this sub-agent was working; it was stopped too.` |
| `run_aborted { detail: "wait_timeout" }`: stopped by the parent's sub-agents wait timeout (§7.2), the parent goes on (`subagent_finished.status` `timed_out`) | `timed out` | true | `stopped: the sub-agent wait timed out` |
| `run_failed { error }` | `failed ({code})` | true | `The sub-agent failed: {message}` |

The status line is part of the logged content, so a full-run replay hands the model the same
`agentId` and a recorded `resume` call matches (§15.2).

### 4.5 Refusals (tool errors, model-visible, actionable)

Written as `isError` results without starting anything:

- `Unknown subagent_type "{x}". Available: {comma-separated roster}.`
- `At most {n} sub-agents can run at once in this run; dispatch the remaining tasks after these finish.`
  (only the calls beyond the limit in a response get it; §8.1)
- `This run has dispatched {n} sub-agents, the limit; do the remaining work yourself.`
- `Sub-agents of this run have used their token budget ({n} tokens); do the remaining work yourself.`
- `No sub-agent with agentId "{id}" in this conversation.` / `Sub-agent "{id}" is still running; wait
  for its result before sending a follow-up.` / `resume cannot be combined with subagent_type or model.`
- `Sub-agents are not available in this conversation.` (the conversation is itself a child; never
  happens with depth 1 because the tool is not offered, kept as a guard).
- Org agents (§5.5): `The agent "{name}" is not available to the person who started this
  conversation; do this task yourself or use another agent type.` (not visible to the starter, no
  longer dispatchable, deleted).

### 4.6 Policy

`agent` has `defaultPolicy: "allow"` **(designer's call)**: dispatching only runs tools the parent
already may run, under the same policies, and each of those calls is approved on its own. An owner
can still set `toolPolicies.agent: "ask"` and a policy hook can deny it (`tool.preExecute` sees the
input, including `subagent_type`).

## 5. Who can be dispatched

### 5.1 Sources **(designer's call)**

| Agent type | Definition source | Use |
|---|---|---|
| `general-purpose` | the parent run's own agent version | superpowers' implementers, reviewers, debuggers: "a fresh copy of me" |
| inline template `<name>` | `subagents.inline[]` in the agent definition (versioned with the agent) | a Capybara-native author's own roles, no plugin needed |
| plugin template `<plugin>:<name>` | an org agent template installed from a plugin (Capybara `agents/*.md` or translated Claude `agents/*.md`), selected in `subagents.templates` | shared roles such as `superpowers:code-reviewer` |
| org agent `<roster name>` | another agent of the org, its current version at dispatch, allowlisted in `subagents.agents` **(decided, 2026-10-26)** | a team's "Jira triage" or "data analyst" agent, with its own connectors, skills and instructions (§5.5) |

### 5.2 Agent definition field

`AgentDefinitionSchema` gains an optional block (no default, so existing definitions gain no
version, as with `skills.pinned`):

```ts
subagents: z.object({
  /** Offer general-purpose (a copy of this agent). Default true. */
  general: z.boolean().optional(),
  /** Org agent template ids (installed from plugins), in roster order. */
  templates: z.array(z.string().min(1).max(100)).max(20).optional(),
  /** Templates written here. */
  inline: z.array(InlineAgentTemplate).max(10).optional(),
  /** Other org agents this agent may dispatch (§5.5), in roster order. */
  agents: z.array(z.object({
    agentId: z.string().min(1).max(100),
    /** Roster name (`subagent_type`), the template name rule. */
    as: z.string().min(1).max(64),
    /** When to use it; shown in the tool description. */
    description: z.string().min(1).max(1024),
  }).strict()).max(10).optional(),
  /** Other agents may dispatch this agent (§5.5). Default false. */
  dispatchable: z.boolean().optional(),
}).strict().optional()
```

`InlineAgentTemplate` = the template fields of §16.1 (`name`, `description`, `instructions`,
`tools`, `toolPolicies`, `model`, `maxSteps`, `skills`), with `skills` as skill ids. The `agent` tool
is offered only when `{ kind: "builtin", name: "agent" }` is in `tools`; `subagents` without it is
kept but unused (the agent page warns). Saving checks (new error `agent.subagents_invalid`, 400, with
`details: [{ reason, … }]`): template ids exist in the org and are not deleted (`not_found`); inline
names and `agents[].as` match `^[a-z0-9][a-z0-9-]{0,63}$`, are unique across the roster and are
not `general-purpose` (`invalid_name`, `duplicate`); inline tools are keys of this agent's tools
(`tool_not_selected`); inline skills are selected by this agent (`skill_not_selected`);
`agents[].agentId` is another live agent of the org, visible to the person saving, with
`subagents.dispatchable: true` in its current version, and not this agent (`agent_not_available`,
`self`); roster ≤ 20 (`too_many`).

### 5.3 Effective definition (narrowing) **(decided: permissions only narrow; details designer's call)**

Computed once, at a sub-agent's first dispatch, and written into the child's log (§6.3):

- `name`: `"{parent name} › {agent type}"`; `avatarUrl`: the parent's.
- `instructions`: `general-purpose` → the parent's instructions; a template → the template body.
- `tools`: the parent's tool refs, filtered to the template's `tools` when it lists any (matched by
  resolved key; a connector ref `tools: "all"` is narrowed to the listed keys), minus its
  `disallowedTools`, **always minus** `agent` (depth 1), `ask_user` (the person does not see the
  child; it reports back instead), `sandbox_deliver` (delivering files to the person is the parent's
  job; the files stay in the shared sandbox) and `skill_write` (a child must not change the agent's
  skills). A template can only remove tools.
- `toolPolicies`: the parent's, then the template's applied on top with "stricter wins"
  (`deny` > `ask` > none); the schema already accepts only `ask` / `deny`.
- `model` / `modelParams` / `fallback`: §5.4.
- `skills`: `orgSkills` the parent's (the child sees the same catalog); `pinned`: the template's
  `skills` that the parent selects (≤ 3 and 32 KB, the pinned limits; extras dropped with a dispatch
  warning in the child's `subagent_started`), **not** the parent's pinned skills: a fresh sub-agent
  should not, for example, start the brainstorming flow that `using-superpowers` demands of a main
  agent; `general-purpose` pins nothing **(designer's call)**. `writePolicy`: unused (no
  `skill_write`).
- `maxSteps` (child only): `min(template maxSteps ?? runtime.maxSteps, runtime.maxSteps)`.

At run time the child's tools are resolved live like the parent's (a tool the parent lost since is
unavailable), and policy is decided live against the **parent agent's current version** (R5) with
the frozen child overlay on top, so a parent tightened mid-run tightens its children too.
**As built (final review I1):** a child run resolves the tool refs of its definition, not the
parent's; a follow-up (`resume`) therefore re-checks before it starts: its type must still be in the
roster of the dispatching run's version (a plugin template by its template id), else the §4.5
unknown-type refusal; and its frozen tools and `orgSkills` are intersected with that version's
(`narrowFollowUp`: a connector's `all` meets the parent's names; a pinned org skill the parent
deselected goes too). The intersection is recorded on the follow-up's task message
(`dispatch.narrowed`), which the child run and its eval case read.

This section is for `general-purpose` and templates. Org agents follow §5.5.

### 5.4 Model tiers → purposes **(decided: purpose, never a model id; tier names designer's call)**

Three kernel model purposes (kind `chat`, in `KERNEL_PURPOSES` next to `eval`, mapped by the org or
deployment admin on the existing model-purposes page): `subagent_fast`, `subagent_standard`,
`subagent_capable`. Resolution for a dispatch:

1. the call's `model` (`inherit` = the parent run's model);
2. else the template's `model`;
3. else `inherit`.

A tier whose purpose is not mapped falls back to the parent run's model (no failure; the
`subagent_dispatched` event records the model actually used and `tierFallback: true`). The mapped
target's params become the child's `modelParams`; with `inherit`, the parent's `modelParams` and
`fallback` / `fallbackParams` carry over. A template `effort` sets `modelParams.effort` when the
resolved model declares that knob (sanitized like any params). A follow-up (`resume`) keeps the
sub-agent's model. An org agent (§5.5) runs on its own model and params; a `model` given on its
dispatch is ignored and the status line says `model: the agent's own`.

### 5.5 Org agents as sub-agents **(decided, 2026-10-26; design designer's call)**

**Who may be dispatched.** Three gates, all required, checked at each dispatch and each `resume`
(live, like R5):

1. **The parent's owner allowlists it**: `subagents.agents[]` of the parent's agent version (§5.2).
   Saving requires the agent to be visible to the person saving (the normal agent visibility rule:
   owner, `visibility = 'org'`, or a member of `agent_members`), so nobody can allowlist an agent
   they cannot see; a private agent can only be allowlisted by its own owner.
2. **The dispatched agent opts in**: its current version has `subagents.dispatchable: true`, set by
   its owner (default false **(decided, 2026-10-26)**). Without it, an agent built for people (with an expensive model or sensitive
   connectors) is never driven by other agents behind its owner's back. Turning it off stops new
   dispatches; running sub-agents finish.
3. **The person who started the parent run can use it**: the same visibility rule evaluated for the
   parent run's trigger account (not the parent's owner). A member of a shared parent agent who is
   not in the dispatched agent's `members` list gets the refusal of §4.5. Deleted agents and agents
   of other orgs are never available.

The agent's own `subagents.agents` is irrelevant to the child (depth 1).

**What is frozen.** The dispatched agent's **current version** at the first dispatch:
`subagent_started.template = { source: "agent", id: agentId, version }` and `definition` = that
version's definition with the overlay below. A follow-up keeps it (the sub-agent's identity), even if
the agent has a newer version since; a new dispatch takes the newest. **As built (final review I1,
maintainer ruling):** a follow-up keeps the frozen instructions and model, but its tools and
`orgSkills` are intersected with the agent's **current** version (the one the gates read under the
dispatch lock) and recorded in `dispatch.narrowed`; a tool removed from the agent never reaches a
follow-up. The parent's tools do not narrow an org agent child (a fresh dispatch is not narrowed by
them either, see above).

**Permission rule (why it never widens).** Everything the starting person can do through a sub-agent
they could already do by opening a conversation with that agent themselves: gate 3 requires that
they can, and the child acts as them (their personal credentials, their approvals). So the child
gets **the dispatched agent's own capabilities, never more**, and the parent can only take away:

- `tools`: the dispatched agent's own tools (its connectors, extension tools, builtins), **not**
  intersected with the parent's; intersecting would make an agent with a connector the parent lacks
  useless, and would add nothing to safety, because the person could use that connector through that
  agent anyway. Always removed: `agent`, `ask_user`, `sandbox_deliver`, `skill_write` (as for
  templates).
- `toolPolicies`: the dispatched agent's, then the parent's for the same tool keys, stricter wins
  (`deny` > `ask` > none). Policy is decided live against the **dispatched agent's** current version
  (its R5) with the parent's current-version policies applied on top, so either owner can tighten a
  running child.
- connector default policies, `requiredRole` and role escalation (R1): as the dispatched agent's
  tools have them.
- `skills`: the dispatched agent's selection, its agent-scoped skills and its pinned skills (its
  owner's choice is part of what the agent is); `skill_write` removed.
- `instructions`, `model`, `modelParams`, `fallback`: the dispatched agent's.
- `maxSteps`: `runtime.maxSteps`.

**Credentials.** The **starting person's** personal connector credentials, and the org credentials
of org-credential connectors, exactly as when they talk to that agent directly. Never the dispatched
agent's owner's personal credentials (an agent never carries its owner's personal connections today,
and dispatch does not change that). A personal connector the person has not connected gives the
usual "connect" result (surfaced in the parent, §9).

**Approvals.** To the starting person (`requestedFor` = trigger account), or by role escalation as
the dispatched agent's tool requires, never to the dispatched agent's owner: the owner is not part of
this conversation. "Always" grants are the person's grants **for the dispatched agent**
(`tool_grants` keyed by account and agent id): the grants they gave when talking to it directly
apply, and an "always" given from inside the sub-agent is stored for that agent. "This
conversation" grants are stored against the parent conversation, as for templates (§9). As built:
a "this conversation" grant is keyed by the tool (key, definition hash, connector), not by agent,
so one given on the dispatched agent's tool also covers the parent agent's own call of the
identical tool in that conversation, and the parent is not asked again (intended: from the
person's view it is one conversation).

**Conversation and accounting.** The child conversation's `agent_id` is the **dispatched** agent
(its `runs.agent_version` is that agent's version), `account_id` the parent conversation's owner,
`parent_conversation_id` the parent. Usage events carry the dispatched agent's id (billing per agent
sees them) and count against the parent run's token budget (§8.3). Hooks see `agentId` /
`agentVersion` of the dispatched agent and `parent` (§11).

**Audit.** Every dispatch writes an audit row `subagent.dispatched` (actor: the starting person;
target: the child conversation; detail: parent conversation, run and call, agent type, source, and
for org agents the agent id and version). A refusal by gates 2 or 3 writes `subagent.refused` with
the gate, so an owner can see attempts to use their agent. As built: every gate's refusal (allowlist and
deleted too) is audited, with target the refused agent's id and detail `gate`, parent
conversation, run, call, agent type and `resumed`; the refusal text names the roster type.

**Sandbox.** The parent conversation's sandbox, like every sub-agent (§10); the dispatched agent's
sandbox tools work on it. The sandbox's limits and egress are the org's, not per agent. As built
(ruling, batch 9 review I2): the conversation is the boundary. Skill files an org agent child loads
are copied into the parent conversation's sandbox (`/skills/<name>/`) and stay there, readable by
later runs of that conversation (another participant of a group thread, or the parent's owner after
losing sight of the agent). The allowlist warning says so (Task 19); not copying files for org-agent
children is a possible later hardening.

**Trajectory.** A sub-agent conversation's trajectory is authorized by its parent conversation's
agent (its owner or an org admin), never by the dispatched agent, whose owner gets 404 (batch 9
review I1).

**UI.** The agent page lists, for the "Sub-agents" section, the org agents visible to the editor
that are dispatchable (name, owner, visibility, a warning when the parent is shared more widely than
the dispatched agent, because some members will be refused at run time, and because its name and
the description are shown to everyone who uses this agent and its skills' files are copied into the
conversation's sandbox); the agent's own settings
get a "Can be used as a sub-agent by other agents" switch. In the conversation, an org agent
sub-agent shows the agent's name and avatar and links to it.

## 6. Child conversations

### 6.1 Shape

A child is a row in `conversations` with:

- `kind = 'subagent'` (the `CHECK` widens from `('chat', 'eval')`);
- `org_id`, `account_id` = the parent's (the conversation owner is the parent's owner, so the
  existing owner-only access rule applies unchanged); `agent_id` = the parent's agent for
  `general-purpose` and templates, the dispatched agent for an org agent (§5.5);
- `parent_conversation_id` (FK to `conversations`, `ON DELETE CASCADE`) and `subagent_type`;
- `title` = the first dispatch's `description`.

`listMine` and the sidebar keep `kind = 'chat'`, so children never appear as conversations of their
own. `get` / `isAccessible` / the events API / SSE accept `kind IN ('chat', 'subagent')`. Posting a
user message to a child is refused with a new error `conversation.read_only` (409). `ensureRun`
already ignores non-`chat` conversations, so nothing ever starts a child run except a dispatch.

### 6.2 Dispatch records

New table `subagent_dispatches`, one row per dispatch (the durable marker of a started dispatch and
the basis of the per-run counters):

| Column | |
|---|---|
| `parent_run_id`, `parent_call_id` | primary key: one dispatch per tool call |
| `parent_conversation_id`, `step` | |
| `child_conversation_id` | the sub-agent |
| `child_run_id` | the child run this dispatch started |
| `resumed` | a follow-up, not a new sub-agent |
| `created_at` | |

A child run's live status is `runs.status` of `child_run_id`; there is no second status column to
keep in sync. Indexes: `(parent_run_id)`, `(child_run_id)`.

`runs` gains `subagent_tokens_used bigint NOT NULL DEFAULT 0` (the parent run's budget counter, §8.3).

### 6.3 The child's log

The first events of a sub-agent, written in the dispatch transaction (§7.1):

1. **`subagent_started`** (new, once per sub-agent, idem key `subagent_started`):
   ```ts
   {
     parent: { conversationId, runId, callId, step },
     agentType: string,                 // as resolved, e.g. "superpowers:code-reviewer"
     template: { source: "general" | "inline" | "plugin" | "agent", id?: string, version?: number, plugin?: string },
     definition: AgentDefinition,       // the effective definition (§5.3)
     preamble: string,                  // SUBAGENT_PREAMBLE at dispatch time
     maxSteps: number,
     warnings?: string[],               // e.g. pinned skills dropped over the limit
   }
   ```
   Model-visible through `definition.instructions` / `definition.skills.pinned` and `preamble`;
   request building for a `subagent` conversation reads the definition from here, never from
   `agent_versions`, so a constant changed later never alters what an old child's request was
   (the same reasoning as the phase B tool map).
2. **`user_message`** with the prompt as one text block, `authorAccountId` = the parent run's
   trigger account, and a new optional field `dispatch: { parentConversationId, parentRunId, callId }`
   (not model-visible; the web uses it to render the task as the gray "task" block of §5.6).

Then the usual run events. A follow-up appends another `user_message` (with `dispatch`, plus
`dispatch.narrowed: { tools, skills? }`, the follow-up's narrowed tools and org skills, as built) and
the next child run absorbs it like any message; that run uses the frozen definition with
`narrowed` in place of its tools and org skills.

The preamble (English, model-visible, rendered in the system text after `BEHAVIOR_RULES` and before
the instructions):

```
You are a sub-agent. Another agent dispatched you with the task in the first user message. Work on
it on your own: the user does not watch this conversation and you cannot ask them questions. When
you are done, reply with your final report. That reply is the only thing returned to the agent that
dispatched you, so include everything it needs. If you cannot finish, say what is missing and why.
```

### 6.4 Child runs

A child run is a normal `runs` row: `conversation_id` = the child, `agent_version` = the parent run's
for templates or the dispatched agent's frozen version for an org agent, `trigger_account_id` = the parent run's trigger account, `trigger_seq` = the task message's
seq. It runs in `RunWorker` with the same `LangGraphLoop`, checkpoints, compaction, deadline
(`runtime.maxRunSeconds`, its own clock), step limit (`maxSteps` from `subagent_started`) and
conversation lock (its own conversation id). The worker branches on `conv.kind = 'subagent'` only to
take the definition from `subagent_started` and to run the finish hook of §7.3.

## 7. Dispatch, suspend and resume across replicas

### 7.1 Inside the parent's tools node

`ToolPipeline.runStep` keeps its order and its invariant (every call of the step gets a result before
the next request is built). `agent` calls get a special path **(designer's call)**:

- An `agent` call never writes `tool_call_started`. The "started without result → result unknown"
  rule (spec 4.3) is for side effects that may have half-happened; a dispatch is instead made durable
  in one PG transaction, and its marker is the `subagent_dispatches` row.
- **Dispatch** (no `subagent_dispatches` row for `(runId, callId)` yet): after input validation,
  policy, approval and `tool.preExecute` (the normal stages), check the limits (§8), resolve the agent
  type and model, then in one transaction (locking the parent run row, so two dispatches of one run
  serialize their limit checks):
  - for a new sub-agent: insert the child `conversations` row; append `subagent_started` and the task
    `user_message` to the child log; for `resume`: append the follow-up `user_message`;
  - insert the child `runs` row (`queued`) and the `subagent_dispatches` row;
  - append `subagent_dispatched` to the parent log (§14.1).
  After commit, enqueue the child run (§7.4) and go on with the **next call of the step**: a
  dispatch never blocks later calls.
- **Already dispatched** (row exists, e.g. on resume): if the child run is terminal, write the
  parent's `tool_result` from the child's log (§4.4), first appending `subagent_finished` to the
  parent log if the child's finisher did not (idempotent by key); otherwise leave the call open.
- After the last call: if any `agent` call of this step has no result, the step returns
  `{ kind: "suspended", waitingFor: { kind: "subagents", id: "sa-<runId>-<step>", expiresAt } }`.
  An approval or input wait of another call in the same step returns as today (later calls wait for
  the resume); `agent` calls dispatched before it keep running.

### 7.2 Suspend

Unchanged machinery: the loop throws `LoopSuspended`, the worker releases the conversation lock and
the org slot, `Waits.suspend` sets the run `waiting`, schedules the wait-timeout job and re-checks.
Changes:

- `WaitingFor.kind` gains `"subagents"`; its id contains no `:` (BullMQ job ids,
  `wait-timeout-sa-<runId>-<step>`).
- `isSettled` for `subagents`: no child run of a `subagent_dispatches` row of this run and step is
  `queued` / `running` / `waiting`.
- **`Waits.resume`'s condition** (the one conditional update `waiting → queued`) adds a third
  `NOT EXISTS`: no `subagent_dispatches` row of the run whose child run is active. One condition for
  all three kinds of wait, so a step that waits on an approval and on sub-agents resumes only when
  both are done, whichever finishes last.
- `expiresAt` of a subagents wait = now + `tools.approvalTimeoutHours` + `runtime.maxRunSeconds` + 10 min:
  long enough for a child that itself waits for an approval; the timeout is a safety net that stops
  the remaining children (§12) so the parent can go on. The children it stops end
  `run_aborted { reason: "user", byAccountId: null, detail: "wait_timeout" }` and report `timed out`
  (§4.4). The wait has no row of its own, so `suspend` records the expiry in
  `runs.wait_expires_at` (cleared on resume); the wait sweep's overdue pass expires a subagents wait
  past it the way the timeout job would, so a lost timeout job is recovered.
- Time spent waiting counts into `waited_ms`, so it is not part of the parent's
  `runtime.maxRunSeconds` (the same as approvals) **(decided, 2026-10-26)**. The parent's total work
  is bounded by its steps and by the dispatch and token caps instead.

### 7.3 Child finish → parent resume

When a child run reaches a terminal state (in `RunWorker.finish`, `Waits.abortWaiting`, the orphan
paths), after the terminal event commits:

1. append `subagent_finished` to the **parent** log (idem key `subagent_finished:<childRunId>`) and
   notify the parent topic: allowed while the parent is `waiting`, as approval decisions already
   write to a waiting run's log; it is not model-visible;
2. call `Waits.resume(parentRunId, waitId = <childRunId>)`. Each finishing child tries; the
   conditional update lets exactly one succeed, the last one to see all siblings terminal (each
   child's own terminal state is committed before it tries, so the last finisher always sees all of
   them). The resume job id `run-<parentConversationId>-resume-<childRunId>` is unique per child.

A failure in 1–2 (crash, PG blip) is repaired by the wait sweep (§7.5); the parent's resumed tools
node writes a missing `subagent_finished` itself (§7.1).

### 7.4 Queue **(designer's call)**

Child runs go to a **separate queue `cap-kernel-subagent-runs`**, processed by the same `RunWorker`
class (a second BullMQ `Worker` on the same process, `runtime.workerConcurrency` each). Reasons: a
replica still on the previous version during a rolling upgrade must never take a child job (it would
run it with the parent's definition from `agent_versions`); and an operator can see child load
separately. `RunQueue.enqueue` (used by `Waits.resume`) picks the queue from the conversation's kind.
Job ids keep the existing shapes with the child conversation id (`run-<child>-<taskSeq>`,
`run-<child>-resume-<waitId>`); no `:` anywhere.

### 7.5 Sweeps

The wait sweep (`wait-sweep-every-10m`, maintenance queue) gains two repairs, both reusing the
normal paths:

- **lost resume**: already covered once the resume condition includes sub-agents (`sweepStuckRuns`:
  waiting past the grace period with nothing pending → resume);
- **orphaned child runs**: a child run `queued` / `running` past the grace period whose job is gone
  and whose conversation lock is free (`RunQueue.isOrphan`, today only reached from `ensureRun`,
  which never runs for children): a `queued` one is re-enqueued (the dispatch committed but the
  enqueue was lost); a `running` one is marked failed `run.orphaned`, which runs §7.3;
- **children of finished parents**: an active child whose parent run is terminal is aborted (§12).
- **open `agent` calls of finished parents** (as built, final review I3): a terminal parent run
  (finished past the grace period, within the last day) with an `agent` call that has no
  `tool_result` gets it under the conversation row lock through `stopOpenAgentCalls` (a child that
  ended gives its result and `subagent_finished`, an active one the stopped text). Without it every
  later request of the conversation would carry an unpaired tool call. Counted as `repaired`.

## 8. Parallelism, limits and accounting

### 8.1 Parallel dispatch

All `agent` calls in one assistant message are dispatched in the same tools-node pass, so they run
concurrently on any replicas with free worker slots, each holding its own org run slot (the parent's
slot is released while it waits, so children never deadlock with their parent). Per parent run at
most `subagents.maxConcurrentPerRun` children are active; the calls of a response beyond that get
the refusal of §4.5 at once **(designer's call: refuse, not queue)**. Queuing would need a dispatcher
that starts the next child when one finishes; refusing is simpler and the model adapts.

### 8.2 Limits **(decided: depth 1, concurrency and token caps; numbers decided, 2026-10-26)**

| Config (`subagents.*`, deployment; org overrides in the deployment setting `subagentLimitOverrides` (orgId → any of the three), like `runConcurrencyOverrides`) | Default | Bound |
|---|---|---|
| `maxConcurrentPerRun` | 4 | 1–20 |
| `maxDispatchesPerRun` (new sub-agents and follow-ups) | 50 | 1–500 |
| `maxTokensPerRun` (sum over the run's children, §8.3) | 5 000 000 | ≥ 10 000 |
| child steps | template `maxSteps`, capped by `runtime.maxSteps` | |
| child duration | `runtime.maxRunSeconds` per child run | |

Depth is fixed at 1 (not configurable in C). A single superpowers task (implementer, reviewer, up to
five fix rounds of two dispatches each) uses at most 12 dispatches; a small plan of 2–3 tasks plus a
final review fits in 50.

The parent's own `runtime.maxSteps` (default 50) is the tighter bound for long plans: each task costs
the controller several steps (brief script, dispatch, review package, dispatch, ledger). The
acceptance plan is sized for it; long plans need a higher `runtime.maxSteps` (§23 R5).

### 8.3 Tokens **(decided: counted against the parent)**

- Every child model call (step, wrap-up and compaction) adds `usageTokens(usage)` (the four usage
  fields, as evals count) to the **parent run's** `runs.subagent_tokens_used` with one
  `UPDATE … RETURNING`, right after its `usage` event is written.
- Before each child model request, the child's step checks the parent counter against the cap
  (fresh read, no cache). At or over the cap, the child run ends without another request, as
  `run_finished { reason: "budget" }` (a new value of the enum, `completed` status), and the
  parent's result says `stopped: token budget used up` (§4.4).
  In-flight requests may overshoot by at most one request per active child (as evals).
- A dispatch when the counter is at or over the cap is refused (§4.5).
- **Where usage shows**: each child's `usage` events stay in its own log (the single source of
  truth). The parent conversation's usage in the UI and API sums its own events plus those of its
  children (through `parent_conversation_id`). `usage.report` fires for child calls with the parent
  named (§11), so billing extensions count them.

## 9. Permissions and approvals

- **Tools and policies**: §5.3 for `general-purpose` and templates (`decidePolicy` reads the parent
  agent's current version, then the child overlay); §5.5 for org agents (the dispatched agent's
  current version, then the parent's policies for the same keys). `fixedAsk` rules (shared agents'
  `skill_write`) do not arise (no `skill_write`).
- **Identity**: `accountId` = the parent run's trigger account; personal connector credentials,
  `requiredRole` and role escalation (R1) behave exactly as when that person talks to the agent whose
  tools run. `agentId` = the parent's agent for templates (so "always" grants are shared with it),
  the dispatched agent for org agents (its grants, §5.5).
- **"Approve for this conversation"** granted on a child's approval is stored against the **parent
  conversation** (`conversation_tool_grants.conversation_id` = parent), and grant lookup for a child
  checks the parent conversation **(designer's call)**: from the person's view the sub-agents work in
  their conversation, and parallel children asking for the same tool are approved once.
- **Approvals and questions go to the starter** **(decided)**, also for org agents (never to the
  dispatched agent's owner, §5.5): child approvals are ordinary
  `approvals` rows of the child run, so `GET /approvals`, the inbox and the decide API work
  unchanged. `ApprovalView` gains `parentConversationId` so the inbox links to the parent
  conversation with the child open.
- **Surfacing in the parent**: when a child run suspends, its `Waits.suspend` also appends
  `subagent_waiting` to the parent log (§14.1). The web renders the approval / input card in the
  parent conversation, labelled with the sub-agent's description, and the channel outbound renders it
  as the same card it renders for `approval_requested` / `question_asked` (by approval or question
  id), so a conversation started from Slack or Lark gets its children's approvals in the thread.
  Without this a child of a channel conversation would wait until expiry.
- **Questions**: `ask_user` is not offered to children; tool `input_required` (extension tools, MCP
  elicitation) still reaches the starter through the same surfacing, because it is tied to a tool
  the parent could call too.
- **Connection required** (a personal connector not connected): written in the child log as today,
  mirrored as `subagent_waiting { kind: "connect" }` only for display (not a wait).

## 10. Sandbox sharing and concurrent commands

**Shared by default (decided); concurrent commands supported in phase C (decided, 2026-10-26).**
Today every operation on a conversation's sandbox runs under one Redis lock, so commands of parallel
sub-agents would queue and fail with `sandbox.busy` after `sandbox.lockWaitSeconds`. Phase C splits
the lock into **shared leases** for using a running sandbox and **exclusive leases** for changing
its lifecycle, tags every command with its holder so a takeover kills only a dead holder's commands,
and adds what providers must declare. The design keeps the three properties the current
`SandboxService` guarantees: one instance per conversation even when replicas race; no stale holder
can write the `sandboxes` row (`generation` fence); a crashed holder's commands are killed before
anyone else relies on the sandbox's state.

### 10.1 Which sandbox

- `BuiltinCallContext` gains `sandboxConversationId` (= the parent conversation for a child, the
  conversation itself otherwise); every `withSandbox`, attachment sync, `skill_load` copy and sandbox
  status call uses it. The `sandboxes` row and every Redis key below are keyed by it.
- **Attachments** of the parent conversation are synced into the shared sandbox (sync keyed by the
  sandbox conversation), so a child can read files the person attached.
- Each child's `read_tool_output` archive is its own (keyed by the child conversation).
- Deleting the parent's agent destroys the parent conversations' sandboxes as today; children have
  none of their own.

### 10.2 Operations by lease kind

| Shared lease (any number up to the cap, concurrently) | Exclusive lease (alone; waits until no shared lease is left) |
|---|---|
| `exec`, `readFile`, `writeFile`, `stat` on a sandbox recorded `running` with the current provider (every `sandbox_*` tool, attachment sync, `skill_load` copies) | `create`, first use, rebuild after `gone`, `resume` from `suspended`, provider switch and `retire`, `suspend` (idle and `maxRunningMinutes` sweeps), `destroy` (sweeps, `destroyFor`), `killAll` after resume |

A shared holder never writes `status` or `handle`; it only updates `last_used_at` (unfenced,
monotonic: `GREATEST(last_used_at, now())`). Every write that changes the row stays under an
exclusive lease and the `generation` fence. As built, **every** acquisition, shared ones included,
bumps `generation` (as every acquisition did before phase C), so an exclusive holder whose lease
lapsed unnoticed is fenced out even when only shared holders came after it; only exclusive holders
compare it (batch 2 deviation 1).

### 10.3 The lease protocol (Redis, multi-replica)

Keys (prefix `capk:`, conversation = the sandbox conversation):

- `sandbox:<conv>`: **the existing lock key, kept** (rollout safety, §10.8). Its value is either an
  exclusive holder's token (as today) or the literal `shared` while shared leases exist. Its TTL is
  the lease TTL (60 s, `SANDBOX_LOCK_TTL_MS`), renewed by holders.
- `sandbox-users:<conv>`: a sorted set of shared lease tokens, score = lease expiry in ms from the
  Redis server clock (`TIME`, the same as the org quota).
- `sandbox-intent:<conv>`: an exclusive waiter's intent, value = its token, TTL max(4 × the poll
  interval, 2 s) as built (the jittered wait reaches almost 2 × poll, so 2 × would lapse between
  polls; the floor covers GC pauses and slow Redis), refreshed while it waits (writer preference).
- `sandbox-holders:<conv>`: a hash `token → expiry` of holders that may have commands running
  (the per-holder replacement of the single busy marker), TTL `maxCommandSeconds` + 10 min.

Lua scripts, each atomic and each purging expired members (`ZREMRANGEBYSCORE … -inf now`) first:

- **acquire shared** `(token, cap, ttl)`: fail if `sandbox:<conv>` holds a token (exclusive), or an
  intent exists (unless this caller is that waiter), or `ZCARD ≥ cap`; else `ZADD` the token,
  `SET sandbox:<conv> shared PX ttl` and succeed.
- **acquire exclusive** `(token, ttl)`: fail if `ZCARD > 0` or `sandbox:<conv>` exists; else `SET
  sandbox:<conv> <token> PX ttl NX`; clear the intent if it is ours.
- **renew** `(token, ttl)`: a shared holder `ZADD XX` its new expiry and `PEXPIRE sandbox:<conv>`
  if its value is `shared`; an exclusive holder renews as today (compare value). Missing member or
  other value → lost.
- **release shared** `(token)`: `ZREM`; when the set is empty, `DEL sandbox:<conv>` if its value is
  `shared`.
- **downgrade** `(token, ttl)`: an exclusive holder that just made the sandbox `running` turns its
  lease into a shared one in one step (`ZADD` itself, `SET sandbox:<conv> shared`), so the call that
  created or resumed the sandbox runs its command without letting a sweep in between.

Holders renew every TTL / 3 and treat "no successful renewal for 2/3 TTL" as lost (the existing
`Held` logic, now per lease): the lease's signal aborts, which aborts that holder's provider calls
and so kills its own commands (§10.6). A crashed holder's lease simply expires out of the set.

**Waiting and caps.** A caller polls (jittered, `lockPollMs`) for up to `sandbox.lockWaitSeconds`,
then gets `sandbox.busy` as today. The shared cap is `sandbox.maxConcurrentCommands` (new, hot,
default 6: the per-run sub-agent cap, the parent's own call in the same step and one spare; 1–32)
**(decided, 2026-10-26)**, or 1 when the provider does not declare concurrent `exec` (§10.7). An exclusive waiter on the use path (first use, resume, rebuild) sets the intent so new
shared leases stop being granted and it gets in once the running commands end; it can still wait up
to `lockWaitSeconds` behind a long command (as today behind any command). Sweeps (`suspendIdle`,
`destroyInactive`) try the exclusive lease once without intent and skip a busy sandbox, as today.

### 10.4 What stays serialized

- **Lifecycle** (exclusive, §10.2).
- **The kernel's own file writes to one path**: `sandbox_write`, `sandbox_edit` (read, replace,
  write), attachment sync and `skill_load` copies take a short per-path Redis lease
  `capk:sandbox-path:<conv>:<sha256(path)>` (TTL 30 s, renewed, waited for up to 30 s, then the tool
  error "Another sub-agent is writing this file; wait a moment and retry." as built, which passes
  `tool-error-actionable`) around their read-modify-write, so two edits of one file never lose an
  update. Reads and `stat` take no path lease.
- **Not serialized**: what shell commands write (N10) **(decided, 2026-10-26)**. The `sandbox_bash` description gains: "Other
  sub-agents of this conversation may run commands in this sandbox at the same time." (A new
  description is a new spec hash; old requests replay from `tool_specs` by their recorded hash.) The
  `agent`
  description asks the parent to give parallel sub-agents separate files (§4.3).

### 10.5 Takeover, `killAll` and per-command tags

The single busy marker cannot tell a dead holder's commands from a live sibling's, so it becomes a
per-holder record:

- Before running its provider calls, every holder writes `HSET sandbox-holders:<conv> <token>
  <expiry>` and passes its token as the new `exec` argument **`tag`** (§10.7); the provider labels
  the command with it. On release the holder deletes its field.
- **On every lease acquisition** (shared or exclusive), the acquirer reads `sandbox-holders` and
  compares it with the live leases (`sandbox-users` members and the exclusive token): a field with no
  live lease belongs to a crashed holder. The acquirer calls the provider's
  **`killTagged(h, tags)`** for those tags and then deletes those fields (with a compare in Lua, so
  two acquirers do not both kill and one does not delete a field another just re-added). Live
  siblings' commands are never touched. `concurrentExec` requires `killTagged` (§10.7); a provider
  that declares one without the other is treated as cap 1 with a startup warn. As built: a shared
  acquirer uses `killTagged` whenever the provider has it, even with cap 1 (while a hot change of
  `maxConcurrentCommands` spreads, a replica on a larger cap may have let a sibling in); a provider
  without `killTagged` gets `killAll` under a shared lease only while that holder is the one shared
  holder, else a warn (the in-sandbox time limit ends the leftover). Holders refresh their record
  before every `exec`, so a callback running several long commands in a row stays recorded.
- **After `resume` from `suspended`**: `killAll` as today, under the exclusive lease (no shared lease
  exists while a sandbox is suspended, so every process is a leftover).
- The old single marker `sandbox-busy:<conv>` is still read: present means a holder from before this
  change crashed while it held the exclusive lock; the next **exclusive** acquirer calls `killAll`
  and deletes it (§10.8).
- **In-sandbox time limit** (`timeout -s KILL`) stays the backstop for every command.

### 10.6 Abort and kill per command

Unchanged per command: each `exec` already runs in its own session with its own control file in both
providers (`/tmp/.capybara-exec-<uuid>`), and an aborted or timed-out `exec` kills exactly its own
process tree. Concurrency adds:

- the control file name carries the tag: `/tmp/.capybara-exec-<tag>-<uuid>` (tags are kernel UUIDs,
  checked against `^[a-z0-9-]{1,64}$` by the provider), and `killTagged` matches
  `capybara-exec /tmp/[.]capybara-exec-<tag>-`;
- **fallbacks that kill everything**: when the kill exec itself cannot start (process table
  exhausted), Docker restarts the container and E2B cold-starts the sandbox, which also ends live
  siblings' commands. They then resolve as aborted or fail with an ordinary error, which the tool
  reports as a failed command; the provider logs a warn. Accepted as a last resort (it is already
  the behavior for the one holder today);
- a holder's lease lost mid-command aborts only that holder's `exec`s.

### 10.7 `sandbox@1` additions (no `sandbox@2`) **(designer's call)**

All additive and optional, so `sandbox@1` stays (the point is single-choice and brokered: the only
consumer is the kernel, which handles both shapes). SDK patch with the API report and a changeset:

```ts
interface SandboxProvider {
  /** Declares that exec / readFile / writeFile / stat may run concurrently on one instance. */
  readonly concurrentExec?: boolean;
  exec(h, args: { …; /** Holder tag, ^[a-z0-9-]{1,64}$; label the command with it. */ tag?: string }): Promise<ExecResult>;
  /** Kill every running exec command labelled with one of `tags` (and its process tree). */
  killTagged?(h: SandboxHandle, tags: string[], signal: AbortSignal): Promise<void>;
}
```

Contract text added to `sandbox.ts` and the `writing-sandbox-providers` skill: with
`concurrentExec`, the four use methods must be safe to call concurrently on one instance, and
**auto-start must be idempotent under concurrent calls** (two calls finding the instance stopped both
start it without failing: Docker's `start` on a running container answers 304, E2B `connect` on a
running sandbox only extends its timeout). A provider that does not declare `concurrentExec` gets
cap 1 (today's behavior), so third-party providers keep working unchanged.

Official providers:

- **Docker**: `docker exec` instances are independent; the socket proxy already allows the exec
  endpoints (no rule change, so `check:compose-haproxy` is untouched). Add the tag to `execArgv`,
  `killTagged` as a variant of `KILL_ALL_SCRIPT`, declare `concurrentExec: true`. The sandbox's
  `PidsLimit` and memory are shared by concurrent commands; the README says so.
- **E2B**: envd runs processes independently (`process.Start` per command); the same tag and
  `killTagged` change in its wrapper script; declare `concurrentExec: true`. Live checks: concurrent
  `connect` calls and concurrent uploads to the staging directory (names are already UUIDs).
- **Fake** (`sandbox-fake`): already spawns a process group per `exec`; record the tag in
  `procs/<pid>`, implement `killTagged`, declare `concurrentExec: true`, and add a delay hook so tests
  can hold commands open.

### 10.8 Rolling upgrade

Old replicas only `SET NX` the lock key and use the single busy marker. Because shared holders keep
the lock key set (`shared`) while any shared lease lives, an old replica can never take the
exclusive lock (and so never suspend, destroy or rebuild) while new replicas run commands, and new
replicas' shared acquisitions fail while an old replica holds the key with its token. Commands of an
old holder that crashed are killed through its single marker by the next exclusive acquirer (only
the caller holding the exclusive lease claims it). No PG migration: the `sandboxes` row and
`generation` are unchanged.

**The reverse direction (as built).** Old replicas don't read `sandbox-holders`, so new holders also
write the single marker `sandbox-busy:<conv>` with the value `v2` (TTL as the holder record, kept
while any holder record exists, deleted with the last one; never overwriting an old holder's
token). New code ignores the value `v2`. When a new holder crashes and an old replica is the next
to take the lock (it can only do so once no shared lease is live), its swap finds a value and it
calls `killAll`, which is safe for the same reason. What the marker misses (for example, an old
replica's release deleting it while a dead record remains, which the next new acquirer still
kills by tag) is bounded by the in-sandbox time limit. The release notes say to finish the rolling
upgrade promptly.

### 10.9 Idle and suspension accounting

- `last_used_at` is set when each lease is released (and stays monotonic: `GREATEST`), so the idle
  clock starts when the **last** concurrent holder finishes.
- `suspendIdle` and the `maxRunningMinutes` suspension only run under an exclusive lease taken with
  one try, so a sandbox with any command running is skipped, as today with one holder. With several
  overlapping holders a busy sandbox can pass `maxRunningMinutes`; the sweep then sets the intent
  for one poll window so new commands briefly wait and the suspension can get in when the running
  ones end **(designer's call)**. The next use resumes it transparently.
- `running_since` is unchanged (set at create / resume).

### 10.10 Failure modes (sandbox)

| Failure | Effect | Recovery |
|---|---|---|
| A replica crashes while two holders (one on it, one elsewhere) run commands | the dead holder's lease expires; its commands keep running until killed | the next acquirer of either kind sees its `sandbox-holders` field without a lease and calls `killTagged` for it; the live sibling's command is untouched; the in-sandbox time limit is the backstop |
| `gone` while several commands run | each holder's call throws `SandboxGoneError` | each releases its shared lease and asks for the exclusive one; the first rebuilds; the others, finding the recorded instance changed, retry once on the new instance; every affected tool result carries "Sandbox was recreated; previous files are gone." An instance is identified by its handle **and** the row's `created_at` (set by the fenced write after each `create`), not by `generation` (shared acquisitions bump it too, as built) nor by the handle alone (sandbox-docker's handle is the instance name, the same after a rebuild, so every holder would rebuild in turn and wipe the instance the previous one had just built) |
| A holder that was not in the call that rebuilt (the parent, a sibling) | its next call would only find files missing | as built (final review m5): each agent conversation's last-used instance is kept in Redis (`capk:sandbox-seen:<conv>:<holder>`), so its next call carries "Sandbox was recreated; previous files are gone." once |
| An exclusive waiter behind a long command | waits up to `lockWaitSeconds` (intent stops new shared leases) | `sandbox.busy`, as today |
| A shared holder loses its lease (Redis blip) | its signal aborts; its own commands are killed | the tool returns the existing lock-lost text; others continue |
| Kill fallback restarts the container / sandbox | live siblings' commands end | they report failed commands; warn logged (sandbox-docker through the extension's `ctx.log`) |
| Two edits of one file | the second waits for the path lease | — |
| Provider without `concurrentExec` | cap 1 | today's behavior |
| Redis loses the keys (failover) | leases vanish; holders' renewals fail → all abort | the next acquirer starts clean; leftover commands are bounded by the in-sandbox limit (the same exposure as today's single lock) |

## 11. Hooks

**Child runs fire hooks (decided).** `hookScope` fires for `chat` and `subagent` conversations
(`eval` still never). SDK changes (additive, a patch per the 0.x rule):

```ts
export interface HookScope {
  …;
  /** Set when the call belongs to a sub-agent: where it was dispatched from. */
  parent?: { conversationId: string; runId: string; callId: string };
}
export interface UsageReportPayload {
  …;
  conversationKind: "chat" | "eval";   // a sub-agent's calls report "chat"
  parent?: { conversationId: string; runId: string; callId: string };
}
```

`conversationKind` is not widened (a new union member would break exhaustive switches in extensions);
`parent` tells the two apart **(designer's call)**. The parent's `agent` call itself fires
`tool.preExecute` / `tool.postExecute` like any tool, so a policy extension can deny dispatches
(by `subagent_type`, prompt size, time of day). Policy hooks fail closed on children as on parents
(`permissions.policyHooks`). `hook_denied` in a child is logged in the child log and fails only that
child run (`run.hook_denied`), which the parent sees as a failed sub-agent. No new mount point in C;
`agent.preStep` and `session.*` stay reserved.

## 12. Cancellation

- **Parent stopped while waiting on sub-agents** (the common case): `Waits.abortWaiting` additionally,
  in its transaction, reads the run's active children; it writes the parent's open `agent` results
  (`The run was stopped while this sub-agent was working; it was stopped too.`) through
  `stoppedResults`, then `run_aborted`. After commit, each active child is stopped: a `waiting`
  child through its own `abortWaiting`, a `queued` / `running` one through `RunAbort.request(childRunId)`
  (the existing cross-replica broadcast plus marker key, so a child that starts later still sees
  it). Each child then finishes `aborted` and §7.3 appends `subagent_finished` to the (terminal)
  parent; its resume attempt is a no-op.
- **Parent stopped while running** (dispatches in progress in its tools node, or its deadline hit):
  the general rule **"when a parent run reaches any terminal state, every active child of it is
  stopped"** runs after the terminal commit in `RunWorker.finish` and `finishRun` callers, with the
  sweep of §7.5 as the backstop.
- **Child stopped from the UI** **(decided: the user can stop a sub-agent)**: `POST
  /conversations/:childId/abort` (owner only, as for any conversation; the existing route accepts
  `subagent` conversations). The child ends `aborted`; the parent's result for that call says
  `stopped by the user` and the parent continues when its other children are done.
- **Shutdown, lost lease, stalled jobs**: children are ordinary runs and follow the existing paths
  (interrupted at a step boundary, resumed elsewhere from their checkpoint).
- **Wait timeout** (§7.2): stops the remaining children as above, then resumes the parent.
- **Deleting** the parent conversation deletes its children (`ON DELETE CASCADE`); a soft-deleted
  agent starts no new runs, and children of its running parents are stopped by the terminal rule.

## 13. Failure modes

| Failure | Effect | Recovery |
|---|---|---|
| Crash after the dispatch transaction, before the enqueue | child run `queued` with no job | sweep re-enqueues it (§7.5); the parent's resumed tools node finds the dispatch row and does not dispatch again |
| Enqueue fails (Redis down) | as above, logged at error | same |
| Crash in the parent's tools node after some dispatches | parent job re-run from its checkpoint; tools node re-entered | dispatched calls are found by `(runId, callId)`; undispatched ones are dispatched now |
| Child run fails (model error, unavailable model, context overflow) | `run_failed` in the child | parent gets `failed ({code})` (§4.4) |
| Child's worker crashes repeatedly | `run.stalled` from BullMQ | same, through `onJobFailed` → §7.3 |
| Child finishes, its finisher crashes before resuming the parent | parent stays `waiting` | sweep resumes it after the grace period; the parent writes the missing `subagent_finished` |
| Child waits for an approval that expires | the child's call gets the expiry text, the child continues | normal |
| Template uninstalled or changed while a sub-agent exists | none: the definition is frozen in `subagent_started` | a follow-up keeps the frozen instructions and model; as built, a template no longer in the roster refuses the follow-up as an unknown type, and its tools are narrowed to the parent's (I1) |
| Parent agent loses a tool mid-run | the child's call to it is `unavailable` (live resolution) | normal |
| Tier purpose unmapped or its model gone | the parent's model is used, `tierFallback: true` | the admin maps the purpose |
| Org run slots full | children wait in the queue (`QUOTA_FULL_DELAY_MS`) | normal |
| Rolling upgrade: a parent with a dispatched child resumes on an old replica | the old pipeline does not know `agent` and writes "unknown tool" | accepted for the rollout window (§23 R6); child jobs never reach old replicas (§7.4) |
| Token cap reached mid-child | child ends with `budget` | parent gets the partial reply |
| Org agent made private, `dispatchable` turned off, or deleted after the parent's owner allowlisted it | the dispatch (or `resume`) is refused (§4.5) and audited `subagent.refused` | the parent's model does the work or uses another type; running sub-agents finish |
| Org agent's tool needs a personal connector the starter never connected | the child's call returns the connect text; `subagent_waiting { kind: "connect" }` shows the card in the parent | the person connects; the child (or a follow-up) retries |
| Sandbox failures with concurrent holders | see §10.10 | |

## 14. Events and APIs for the UI

### 14.1 Parent log (new event types, none model-visible; request building skips them)

```ts
subagent_dispatched: {
  step, callId, subagentId /* child conversation id */, childRunId,
  agentType, description, resumed: boolean,
  model: { provider, model }, tierFallback?: boolean,
}
subagent_waiting: {
  subagentId, childRunId, kind: "approval" | "input" | "connect",
  approvalId?, questionId?, toolKey, expiresAt?,
}
subagent_finished: {
  subagentId, childRunId, callId,
  status: "completed" | "max_steps" | "max_duration" | "budget" | "aborted" | "failed",
  errorCode?, toolCalls: number, durationMs: number,
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
}
```

They carry what UI §5.6 rows need (status, kind tag = `agentType`, task name = `description`, call
count, duration) without reading the child. The model-visible part stays the `tool_call` /
`tool_result` pair.

### 14.2 Progress (ephemeral) **(designer's call)**

While a child runs, the kernel publishes on the **parent's** conversation topic a stream message
`{ kind: "subagent_progress", subagentId, step, toolCalls, lastToolKey? }` after each child step (the
same bus the text deltas use; not in the log, lost on reconnect). A reconnecting client reads the
current numbers from the summary API below. Writing a log event per child step would bloat the parent
log for no replay value.

### 14.3 APIs

- `GET /conversations/:id/subagents`: the parent's sub-agents (id, agent type, description, current
  child run status, tool calls, started / finished, usage, pending approval / question ids), newest
  first, pageable. Owner only.
- `GET /conversations/:childId`, `…/events`, `…/stream`: unchanged routes, now accepting `subagent`
  conversations; the conversation view gains `parentConversationId`, `subagentType`.
- `POST /conversations/:childId/abort`: §12. `POST …/messages` on a child: 409
  `conversation.read_only`.
- Conversation usage (the Context panel): includes children (§8.3).

## 15. Replay and evals

### 15.1 Drift and request building

- Parent requests change only through the `agent` tool definition (tools segment, by spec hash,
  already covered by `tools_changed`) and `tool_result` content (in the log). The zero-drift fixtures
  (`reconstruct.test.ts`, `rename-compat.test.ts`) must stay green: the new event types are skipped by
  request building, and a log without them builds byte-identically.
- Child requests are built from the child log, with the definition and preamble from
  `subagent_started` instead of `agent_versions` (§6.3). New `DriftReason` **`subagent_changed`**:
  a step replay of a child case with a candidate (another parent agent version, another template
  version, or, for an org agent, another version of the dispatched agent) whose effective
  definition differs from the logged one (`subagent_started.template.version` names the version the
  child really ran); the request still renders the
  logged definition, as `pinned_changed` does (AGENTS.md: new model-visible input goes into the log
  with a matching drift reason).

### 15.2 Full-run replay of a parent with sub-agent calls

Full-run replay runs the parent's loop in a hidden `eval` conversation with `RecordedToolPipeline`,
which never executes tools: an `agent` call is matched like any call by `(toolKey, canonical input)`
to the original run's recorded result, and the recorded result text (the child's final reply and
status line) is returned. So **no child is started** (A3), no `subagent_*` events are written, child
tokens are not spent and do not count against the eval's token cap, and parallel `agent` calls in one
response replay in the same step. A `resume` call matches because the recorded status line gave the
model the same `agentId`. A candidate that dispatches differently gets `REPLAY_NO_RECORDING`
(`tool_unmatched`), as for any tool. Replaying children "for real" inside a parent replay is not
offered in C: it would execute tools.

### 15.3 Step and full-run replay of a child

A child run is an ordinary run of an ordinary conversation, so the trajectory viewer can make an eval
case of it. `CaseSnapshot` gains `subagent?: { definition, preamble }` (copied from
`subagent_started`; the event is also in `events`), and `definitions` is not consulted for such a
case. Step replay reconstructs the child request exactly; full-run replay runs the child's loop with
the logged definition and recorded tools. The case notes its parent (`parent` in the case metadata)
for navigation only.

For an org agent child the case's `agentId` / `agentVersion` are the dispatched agent's (its
`runs.agent_version`), so the eval set lists it under that agent, and a candidate agent version for
the case is that agent's next version (drift `subagent_changed` when the effective definition
differs).

### 15.4 Trajectory viewer

The parent's trajectory shows each `agent` call as a tool span with the child's status and a link to
the child's trajectory; the child's trajectory header links back. Privacy rules are unchanged (a
child is visible exactly when its parent is: same org, same owner, `trajectory.viewed` audited, 404
otherwise).

## 16. Agent templates

### 16.1 Capybara template format (`agents/<name>.md` in a plugin)

Markdown with YAML frontmatter, body = instructions (like `SKILL.md`):

| Field | Type | Meaning |
|---|---|---|
| `name` | `^[a-z0-9][a-z0-9-]{0,63}$`, required | type name (`<plugin>:<name>` in the roster) |
| `description` | string ≤ 4096, required | when to use it; shown in the `agent` tool description (cut to 1024) |
| `tools` | list of tool keys (builtin names, `<ext>__<tool>`, `<connector-slug>__<tool>`) | allowlist; omitted = the parent's tools |
| `disallowedTools` | list of tool keys | removed |
| `toolPolicies` | map key → `ask` / `deny` | tightened |
| `model` | `inherit` / `fast` / `standard` / `capable` | tier (§5.4); default `inherit` |
| `effort` | `low` … `max` | sets `modelParams.effort` when declared |
| `maxSteps` | 1–`runtime.maxSteps` | step limit |
| `skills` | list of skill names | preloaded (pinned in the child), ≤ 3 |

The SDK exports `parseAgentTemplate(text)` (pure, frontmatter + limits `AGENT_TEMPLATE_LIMITS`:
body ≤ 100 000 characters, at most 64 templates per plugin) used by the kernel, the packer and
`capybara-plugin check`.

### 16.2 Plugin manifest

`PluginManifest.agents` changes from the reserved empty list to `PluginAgentRef[]`
(`{ path: "./agents/<name>.md" }`); omitted = scan `agents/*.md` (as `skills` scans `skills/`). The
JSON Schema in `packages/plugin-sdk/schemas/` is regenerated (`pnpm gen:package-schemas`). A plugin
with templates still needs no extension and no permission approval; the import review lists them in
the "imported" group with their tool narrowing and model tier.

### 16.3 Org install, upgrade, uninstall

- New tables `agent_templates` (`id`, `org_id`, `name`, `plugin_name` (NOT NULL), `catalog_item_id`
  provenance, `current_version`, `deleted_at`, unique `(org_id, plugin_name, name) WHERE deleted_at
  IS NULL` as built, which matches the `<plugin>:<name>` roster type) and
  `agent_template_versions` (`template_id`, `version`, `definition jsonb` (the parsed frontmatter and
  body), `source_format` `capybara` / `claude-code`, `created_at`).
- Install creates templates as components (`plugin_install_components.kind` gains
  `agent_template`); names are scoped by plugin (`<plugin>:<name>`), so two plugins never conflict
  and no `plugin.*_conflict` code is needed.
- Upgrade adds a version to changed templates (preview lists added / changed / removed templates in
  the existing diff, part of `diffHash`); agents selecting a template keep it; sub-agents already
  started keep their frozen definition.
- Uninstall removes templates nothing selects; a template an agent selects is kept with
  `used_by_agents` (existing report reason), and dispatches of it keep working until the agent drops
  it.
- Rollback restores the previous template versions, as for skills.

### 16.4 Claude `agents/*.md` translation (catalog, `packages/kernel/src/catalog/claude`)

The `agents/` directory joins the translated tree (it is excluded today), the body is copied
unchanged, and the translated frontmatter is generated next to it in
`.capybara-generated/agents/<name>.md` as built (frontmatter written as JSON, which is valid YAML,
then the body unchanged: the SDK requires `agents[].path` to be `.md`, so import, install, upgrade
and the packer share one reader; the source file is never rewritten, §8.1 of the parent spec). `agent_needs_subagents` is retired; new report codes:

| Claude field | Translation | Report |
|---|---|---|
| `name` | `name` when it matches the template name rule, else the agent is skipped | `agent_imported` / `agent_invalid` |
| `description` | `description` (≤ 4096) | — |
| body | instructions, unchanged | — |
| `tools` | each name through the tool-name table: `Bash` → `sandbox_bash`; `Read` / `Write` / `Edit` / `MultiEdit` / `Glob` / `Grep` → `sandbox_*`; `Skill` → `skill_load`; `TodoWrite` → `todo__write`; `ToolSearch` → `tool_search`; `Agent` / `Task` dropped (depth 1); `AskUserQuestion` dropped (children cannot ask); anything else dropped. Omitted = inherit | `agent_tools_unmapped` (warning, lists dropped names) |
| `disallowedTools` | same table, into `disallowedTools` | same |
| `model` | `haiku` → `fast`; `sonnet` → `standard`; `opus`, `fable` → `capable`; `inherit` / absent → `inherit`; a full id → by the family name it contains, else `inherit` | `agent_model_mapped` when not one-to-one |
| `maxTurns` | `maxSteps` (capped) | — |
| `skills` | `skills` (names; > 3 cut) | `agent_skills_truncated` |
| `effort` | `effort` | — |
| `permissionMode`, `hooks`, `mcpServers` | ignored (Claude ignores them for plugin agents) | `not_applicable` |
| `memory`, `background`, `isolation`, `omitClaudeMd`, `autoCompactWindow`, `initialPrompt`, `experimental`, `color` | ignored | `agent_field_ignored` |

Claude agent `name`s may contain characters Capybara does not accept (up to 256 characters);
those agents are skipped with the reason, never renamed. superpowers' `code-reviewer`
(`model: inherit`, no `tools`) becomes `superpowers:code-reviewer` with the parent's tools.

### 16.5 Tool-name map

The `Task` / `Agent` line of `CLAUDE_CODE_TOOL_MAP` becomes:

```
- Task and Agent (sub-agents) -> agent when it is in your tools (subagent_type names one of the types its description lists; model names haiku / sonnet / opus -> fast / standard / capable; SendMessage to a sub-agent -> agent with resume); otherwise not available: do the steps yourself, in order
- TaskOutput, TaskStop -> not available
```

The map is stored in the `skills_catalog` snapshot when the snapshot is written, so conversations
keep their old text until their next snapshot and replays never change; `reconstruct.test.ts` gains
a case with the new text.

## 17. Web UI scope

**Phase C ships on today's conversation page** (PlaygroundPage + Inspector), built only from
`@capybara-hq/design` (`check:web-ui`), with the §5.6 shapes where they are cheap **(designer's
call)**:

- design components `SubagentGroup` / `SubagentRow` (status, kind tag, description, call count,
  duration, `›`), following UI §5.6's data shape, in `/dev/ui` with fixtures and screenshot tests;
- the message list renders `agent` calls with them (from `subagent_dispatched` / `subagent_finished`
  and progress messages) instead of generic tool rows;
- clicking a row opens the child read-only in the Inspector as a "Sub-agent" view: the task block,
  a line with agent type, model and tools, its message list (the existing components), a stop
  button; an open child streams through the same SSE route;
- child approvals and questions appear in the parent conversation as the existing cards with the
  sub-agent's name (`subagent_waiting`), and in the inbox with a link to the parent;
- the agent page gets a "Sub-agents" section: the `agent` tool toggle, general-purpose on / off, the
  installed templates to select (with source plugin), inline templates (FormSection list), and org
  agents to allowlist (name, owner, visibility, roster name and description; a warning when the
  parent is shared more widely than the chosen agent), plus the switch "Can be used as a sub-agent
  by other agents" (`dispatchable`);
- an org agent sub-agent shows that agent's name and avatar in its row and Inspector view, with a
  link to the agent; refusals (§4.5) show as failed rows with the reason;
- the import review and catalog item list agent templates; the model-purposes page lists the three
  tiers (labels zh / en);
- i18n for all new texts (zh and en).

**UI refresh B** (§5.6) then replaces the Inspector view with the right panel (header with back,
stop, full screen), adds the tinted open row, the in-place step summary and the "Background tasks"
section (listing running sub-agents; in C every running sub-agent is a foreground one of the current
run), and the status bar. If UI B lands first, C wires B's components instead of building the
interim ones. §5.9's "subagent event shapes" row is answered by §14.

## 18. Migrations

One additive file `00NN_subagents.sql` (the next free number when it merges: `0052`, or `0053` if UI
refresh A's `0052_conversations_account_agent_idx.sql` lands first; the migrator refuses a file
older than one already applied):

- `conversations`: replace the kind check (`DROP CONSTRAINT IF EXISTS` the generated name, add
  `CHECK (kind IN ('chat', 'eval', 'subagent'))` in a `DO` block that skips when present); add
  `parent_conversation_id text REFERENCES capybara.conversations(id) ON DELETE CASCADE`,
  `subagent_type text`; partial index on `parent_conversation_id WHERE kind = 'subagent'`;
- `runs`: `subagent_tokens_used bigint NOT NULL DEFAULT 0`;
- `subagent_dispatches` (§6.2);
- `agent_templates`, `agent_template_versions` (§16.3);
- `plugin_install_components.kind` check gains `agent_template`.

As built, a second additive file `0054_subagent_wait_expiry.sql` adds the nullable
`runs.wait_expires_at` (the expiry of a subagents wait, §7.2) with a partial index on waiting runs.
A third, `0055_subagent_parent_indexes.sql` (final review I2), indexes
`conversations (parent_conversation_id) WHERE parent_conversation_id IS NOT NULL` and
`subagent_dispatches (parent_conversation_id)`: the self-FK and dispatch-row `ON DELETE CASCADE`
look rows up by parent with no `kind` predicate, which the partial `conversations_parent_idx` cannot
serve.

The agent definition fields (`subagents.agents`, `subagents.dispatchable`) live in
`agent_versions.definition` (JSON), so they need no column. Concurrent sandbox commands need **no PG
change** (the `sandboxes` row and `generation` are unchanged); their state is Redis keys
(`capk:sandbox-users:<conv>`, `capk:sandbox-intent:<conv>`, `capk:sandbox-holders:<conv>`,
`capk:sandbox-path:<conv>:<hash>`, and the kept `capk:sandbox:<conv>`), with the rollout rule of
§10.8. All expand-only (old code never writes the new values; widened checks are safe on old replicas).
Zero-downtime rules apply (0.1.0 is released before phase C).

## 19. Config, error codes, SDK

- Config (`docs/config.md` regenerated): `subagents.maxConcurrentPerRun`,
  `subagents.maxDispatchesPerRun`, `subagents.maxTokensPerRun`, `sandbox.maxConcurrentCommands`
  (all `hot`); org overrides for the `subagents.*` values in org settings.
- Audit actions: `subagent.dispatched`, `subagent.refused`.
- Kernel purposes: `subagent_fast`, `subagent_standard`, `subagent_capable`.
- Error codes: `agent.subagents_invalid` (400), `conversation.read_only` (409).
- New event types: `subagent_started` (child), `subagent_dispatched`, `subagent_waiting`,
  `subagent_finished` (parent); `user_message.dispatch`; `run_finished.reason` gains `budget`.
- SDK: `PluginManifest.agents: PluginAgentRef[]`, `parseAgentTemplate`, `AGENT_TEMPLATE_LIMITS`,
  `HookScope.parent`, `UsageReportPayload.parent`, and in `sandbox@1` (§10.7)
  `SandboxProvider.concurrentExec`, `exec` argument `tag`, `killTagged`; API report regenerated and a changeset bumping
  `@capybara-hq/plugin-sdk` (`check:sdk-api`, `check:sdk-api-changeset`); package schemas
  regenerated.
- Skills to update: `writing-tools` (the `agent` builtin), `writing-plugins` (agent templates,
  Claude agents), `replay-evals` (§15), `writing-extensions` (hook `parent`), `writing-sandbox-providers`
  (shared sandbox key, shared and exclusive leases, tags, `concurrentExec`, `killTagged`, idempotent
  auto-start).

## 20. Phases and tasks (outline for the plan)

| Task | Content | Main files |
|---|---|---|
| C1 Schema and events | migration; event schemas; request building skips new events; `subagent_started` read path; zero-drift fixtures before and after | `migrations/00NN_subagents.sql`, `conversations/events.ts`, `runtime/context/build.ts`, `db/kernel-schema.ts` |
| C2 Effective definition | `subagents` field and checks (incl. `agents`, `dispatchable`); `general-purpose` / inline resolution; narrowing; tier purposes | `agents/definition.ts`, `agents/agents.service.ts`, new `runtime/subagents/definition.ts`, `models/purposes.ts` |
| C3 Dispatch and resume | the `agent` builtin; tools-node path; limits and counters; `subagents` waits; resume condition; child finish hook; `cap-kernel-subagent-runs`; sweeps; audit | `tools/builtins/agent.ts`, `tools/pipeline.ts`, `runtime/waits.ts`, `runtime/run-worker.ts`, `runtime/run-queue.ts`, new `runtime/subagents/*.ts` |
| C4 Permissions and hooks | policy overlay; parent-conversation grants; `subagent_waiting` and channel cards; hook scope and usage report | `tools/policy.ts`, `tools/approvals.service.ts`, `channels/outbound.ts`, `runtime/hook-calls.ts`, `runtime/usage-report.ts`, plugin-sdk `hooks.ts` |
| C5 Org agents | the three gates (allowlist, `dispatchable`, visibility to the starter) at dispatch and resume; the dispatched agent's frozen version and overlay; its grants and credentials; `subagent.refused`; child conversation `agent_id` | new `runtime/subagents/org-agents.ts`, `agents/agents.service.ts` (visibility helper), `tools/policy.ts` |
| C6 Concurrent sandbox | shared / exclusive leases (Lua), downgrade, intent, per-holder records and `killTagged` takeover, path leases, `sandboxConversationId`, `last_used_at` and suspension rules, rollout compatibility; SDK `sandbox@1` additions | `sandbox/sandbox.service.ts`, new `sandbox/leases.ts`, `tools/builtins/sandbox/*.ts`, plugin-sdk `sandbox.ts` |
| C7 Providers | Docker, E2B and fake: tags, `killTagged`, `concurrentExec`, idempotent auto-start; READMEs | `plugins/sandbox-docker`, `plugins/sandbox-e2b`, `packages/kernel/test/fixtures/plugins/sandbox-fake` |
| C8 Cancellation | cascade on parent terminal / waiting abort; child abort; wait timeout | `runtime/waits.ts`, `conversations/conversations.service.ts`, `runtime/run-finish.ts` |
| C9 APIs | sub-agent list; child access; read-only; usage sums | `conversations/*` |
| C10 Templates in plugins | SDK parser and manifest; catalog read and review; org install / upgrade / uninstall / rollback; tables | plugin-sdk `plugin-manifest.ts`, new `agent-template.ts`, `catalog/plugin-*.ts`, `tools/pack-plugin` |
| C11 Claude translation | `agents/*.md` translation and report codes; the tool-name map line | `catalog/claude/translate.ts`, `report.ts`, `runtime/context/claude-tools.ts` |
| C12 Replay and evals | `subagent_changed` (templates and org agent versions); snapshot `subagent`; parent full-run replay test; child step and full-run replay; trajectory links | `evals/*` |
| C13 Web | components, conversation page, Inspector view, agent page (templates, org agents, `dispatchable`), review, purposes, i18n, screenshots | `packages/design`, `apps/web` |
| C14 Acceptance | the superpowers end-to-end test; dual-replica tests; live checklist | `packages/kernel/test/subagents/*`, `packages/kernel/test/sandbox/*`, fixture update |

C1–C4, C8 and C9 are the runtime and can merge behind no flag (the tool is opt-in per agent). C6–C7
(concurrent sandbox) are independent of the rest and can go first: with one holder per sandbox they
behave exactly as today. C5 follows C2–C4. C10–C11 can run in parallel with C3–C9 after C2.

## 21. Acceptance

**§12 (decided)**: superpowers' `subagent-driven-development` runs a small plan in Capybara.
Concretely:

- **End to end on fakes** (`packages/kernel/test/subagents/superpowers-sdd.e2e.test.ts`, one kernel,
  `model-fake` scripted, the fake sandbox extension with a git-capable workspace, no network): the
  superpowers fixture gains `skills/subagent-driven-development` (with `implementer-prompt.md`,
  `task-reviewer-prompt.md`, `re-review-prompt.md`, `scripts/`), `requesting-code-review` and
  `dispatching-parallel-agents` from 7.0.x (documented in `FIXTURE.md`) and keeps
  `agents/code-reviewer.md`. An agent with the sandbox tools, `skill_load`, `agent` and the template
  `superpowers:code-reviewer` is given a two-task plan file; the parent loads the skill, runs
  `scripts/task-brief`, dispatches an implementer (`model: "fast"`) that writes and commits, runs
  `scripts/review-package`, dispatches a task reviewer that finds one issue, resumes the implementer
  (`resume`), dispatches a scoped re-review, repeats for task 2, then dispatches
  `superpowers:code-reviewer` (`model: "capable"`) for the final review. Checked: each child's first
  request contains only its system text and the prompt; the results reach the parent as
  `tool_result`s with the status line; the commits are in the shared workspace; the tier purposes
  resolve (one mapped, one falling back); usage sums into the parent run's counter.
- **Parallel**: three `agent` calls in one response run concurrently (overlapping child run
  intervals on two worker replicas) and the parent resumes once, after the last; a fourth and fifth
  call with `maxConcurrentPerRun: 3` get the refusal.
- **Dual replica** (`subagents.dual.test.ts`): the parent runs on replica A, children on B, a child
  approval decided through the API on A, the parent resumed on B; a replica killed mid-child
  (stalled → `run.stalled` → parent result `failed`); a lost enqueue repaired by the sweep.
- **Approvals and channels**: a child's `ask` tool shows as a card in the parent (event) and in a
  fake channel thread; "approve for this conversation" covers a sibling's identical call.
- **Cancellation**: stopping the parent while three children run leaves all four `aborted` and the
  parent's `agent` calls with the stop text; stopping one child gives the parent a `stopped by the
  user` result and the parent completes.
- **Replay**: the e2e conversation's parent full-run replay sends the same requests with zero
  `tool_unmatched` and starts no child; each child's steps reconstruct with `drift: []`; the
  zero-drift fixtures pass unchanged.
- **Translation**: importing the superpowers fixture lists `code-reviewer` as an imported agent
  template; the `mixed` fixture's `reviewer` too, with its ignored fields reported.
- **Org agents** (`packages/kernel/test/subagents/org-agents.test.ts`): a shared "analyst" agent with
  a connector the parent lacks and `dispatchable: true`, allowlisted by the parent's owner, is
  dispatched; its tool runs with the **starter's** personal credential, its `ask` policy plus the
  parent's `deny` on another key give the stricter result, its approval goes to the starter and its
  "always" grant is stored for the analyst agent; `subagent.dispatched` is audited. Refusals: a
  member of the shared parent who is not in the analyst's members list, `dispatchable` turned off
  after allowlisting, a deleted agent (each audited `subagent.refused`); saving an allowlist with an
  agent the editor cannot see is 400 `agent.subagents_invalid`. A follow-up after the analyst got a
  new version keeps the old version; a step replay of the child with the new version as candidate
  reports `subagent_changed`.
- **Concurrent sandbox, fake provider** (`packages/kernel/test/sandbox/concurrent.test.ts`): three
  holders run held-open commands at the same time (overlapping intervals in the fake's ops log); a
  fourth over `maxConcurrentCommands: 3` waits and gets in when one ends; an exclusive operation
  (rebuild after `removeFakeSandbox`) waits for the shared leases and, with its intent set, is not
  starved by new commands; after `gone` with three running holders the sandbox is rebuilt once
  (generation + 1) and all three results carry the recreated notice; two `sandbox_edit`s of one file
  both apply; a provider without `concurrentExec` gets cap 1; an old-style holder (`SET NX` token on
  `capk:sandbox:<conv>`) blocks shared leases and a `shared` value blocks its `SET NX`.
- **Concurrent sandbox, dual replica** (`packages/kernel/test/sandbox/concurrent.dual.test.ts`, fake
  provider): holders on replicas A and B run commands concurrently; A is killed mid-command; B's
  command finishes normally; the next acquirer on B kills only A's tagged command (`killTagged` in
  the ops log, B's process alive until it exits); suspension is skipped while any holder is live and
  happens after the last one ends.
- **Concurrent sandbox, real Docker** (`plugins/sandbox-docker/test/concurrent.test.ts`, skipped
  without Docker): two `sleep 2; date +%s%N` commands overlap in time; `killTagged` kills one tag's
  process tree and leaves the other running; a timed-out command kills only itself; the restart
  fallback ends both (documented behavior); the socket proxy needs no new rule. **E2B**: the same
  cases on `startFakeE2B`, and concurrent processes and uploads in `test/live` with the E2B keys.
- **Live** (manual, added to the release checklist; `CAPYBARA_TEST_*` keys from the local env file):
  the real `obra/superpowers` imported from git, an agent on a real model provider with
  `sandbox-docker` runs `subagent-driven-development` on a two-task plan in a small repository and
  ends with a clean final review.

## 22. Left to the builder

The exact wording of the model-visible texts within the stated content; the status line format;
progress message throttling; whether `subagent_waiting` for `connect` is worth a card; index choices;
how the Inspector view is laid out within the existing templates; how many fixture files to copy from
superpowers 7.0.x (the license is MIT; keep `FIXTURE.md` current).

## 23. Risks

- **R1 Concurrent commands in one sandbox**: parallel children share CPU, memory and the process
  limit of one sandbox, and can clobber each other's files through shell commands. Mitigation: the
  `agent` and `sandbox_bash` descriptions say so; kernel file tools are serialized per path; the
  cap `sandbox.maxConcurrentCommands`; a kill fallback (restart) that ends siblings' commands is
  logged.
- **R1a Lease protocol complexity**: shared / exclusive leases, intent and per-holder takeover replace
  a simple lock in code that guards users' files. Mitigation: the protocol is a few Lua scripts with
  their own unit tests; `maxConcurrentCommands: 1` restores exactly today's behavior as an operator
  switch; the dual-replica tests kill a holder mid-command.
- **R8 Org agents and trust between owners**: an agent owner may not expect their agent's
  instructions or connectors to be driven by another agent's prompts. Mitigation: opt-in
  `dispatchable`, the starter must be able to use the agent anyway, audit rows for every dispatch and
  refusal, and policy tightening by both owners.
- **R2 Cost**: a parent can spend `maxDispatchesPerRun × child steps` model calls. Mitigation: the
  token cap per parent run, tier purposes, usage visible in the parent's Context panel and reported
  to billing hooks.
- **R3 Prompt cache**: the `agent` description holds the roster, so editing a template description
  changes the tools segment of every conversation of agents that select it (a one-time cache miss
  at their next request). Accepted; the roster is small.
- **R4 Parallel children and org slots**: a parent with four children holds four of the org's run
  slots (default 10). Mitigation: per-run concurrency default 4; org admins can raise the org limit.
- **R5 Parent step budget**: long plans exhaust the parent's `runtime.maxSteps` before the children's
  budget. The acceptance plan is small; a per-agent step limit is a separate, later decision.
- **R6 Rolling upgrade window**: a parent resumed on an old replica after dispatching gets "unknown
  tool" for its `agent` calls. Child jobs are on their own queue, so they never run on old code.
- **R7 Model behavior**: models not trained on a dispatch tool may write vague prompts. The tool
  description states the "sees only your prompt" rule; skills such as superpowers carry templates.

## Phase C as built

Built on branch `feat/ecosystem-phase-c` with the plan `docs/superpowers/plans/2026-10-26-ecosystem-phase-c-subagents.md`
(20 tasks). Sentences above that changed in the build say "as built" in place (§5.5, §10.2, §10.3, §10.4,
§10.7, §10.8, §10.10, §16.3, §16.4, §18); this section lists every deviation and ruling in one place. Acceptance:
`packages/kernel/test/subagents/superpowers-sdd.e2e.test.ts` (§21 "End to end on fakes", with the superpowers 7.0.1
fixture extended by `subagent-driven-development`, `requesting-code-review` and `dispatching-parallel-agents`, MIT,
`FIXTURE.md`); the live item is `docs/superpowers/plans/phase-c-live-acceptance-checklist.md`.

**Schema and events.**
- Migration `0053_subagents.sql` swaps the `conversations.kind` and `plugin_install_components.kind` checks with
  `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT … NOT VALID` (the writing-migrations style, one transaction, no
  table scan under the exclusive lock), not a `DO` block. A second additive file, `0054_subagent_wait_expiry.sql`,
  adds `runs.wait_expires_at` (0053 is never edited once applied).
- `agent_templates`: `plugin_name` NOT NULL, unique `(org_id, plugin_name, name) WHERE deleted_at IS NULL` (§16.3;
  the plan's key, matching `<plugin>:<name>`); the CHECKs are re-added `NOT VALID`. An `agent_template` install
  component reuses `plugin_install_components.skill_version` for the template version it added.
- `subagent_started.definition` is validated with `AgentDefinitionSchema` on write (defaults filled in). Request
  building reads the child's instructions and preamble from `subagent_started`; the run worker passes the same
  definition, so they always agree.
- `subagent_finished.status` gains `timed_out` (with `run_aborted.detail: "wait_timeout"`): a child stopped by the
  parent's sub-agents wait timeout reports `timed out` / `stopped: the sub-agent wait timed out` (§4.4 row).

**The `agent` tool (§4).**
- Description layout: the fixed text as one paragraph, a blank line, `Agent types (subagent_type):`, one line per
  roster entry. Roster text from owners and plugins is made inert (`<` / `>` shown as `‹` / `›`). A deleted or
  unknown org agent's line ends `(another agent, with its own tools and model)`. An empty roster offers no `agent`
  tool.
- **The description varies with config** (ruling, batch 6-7 review): it shows the organization's
  `subagents.maxConcurrentPerRun`, so its spec hash changes with the roster and with that limit. Replays read specs
  by hash (no `DriftReason`); drift review covers connector tools only; a remembered grant on `agent` (only when an
  owner set it to `ask`) lapses when the hash changes, as for any spec change; the prompt cache misses once.
- Status line formats (pinned by tests): tokens comma-grouped (`12,345 tokens`, also in the budget refusal),
  durations `4s` / `1m 05s` / `1h 02m`, `1 tool call` singular, an org agent's ignored `model` shown as
  `· model: the agent's own ·`, a stop by the parent `stopped with this run`, a failure without code `failed`, one
  without message `The sub-agent failed.` Duration is the child run's `run_started` to its terminal event (its own
  waits included).
- The pipeline handles `agent` (no flag on `BuiltinTool`; the `run` stub refuses with `notAvailableHere`). The
  parent's result is audited `tool.called` and fires `tool.postExecute` when written (stop texts too); its
  `authorization` is set only when an approval allowed the call (the dispatch-time decision is not recorded; a
  later improvement could put it in `subagent_dispatched`). Every dispatch is audited `subagent.dispatched`; limit
  refusals are not audited.

**Effective definitions and org agents (§5).**
- Policies merge stricter-wins without filtering to the child's tool keys (a key outside the tools is inert;
  filtering could drop a deny on an unresolvable connector); for org agents all parent policies are layered on, not
  only "same keys" (same or stricter result). The child definition never carries `subagents` or
  `skills.writePolicy`; its name is cut to 80 characters; a connector ref narrowed by an allowlist or deny lists its
  tools by name.
- Save checks keep entries already in the current version ("kept", like pinned skills): an uninstalled template or
  an agent switched off later does not block unrelated edits. The gates are not part of the roster: all four
  (allowlist read from the parent's **current** version, `dispatchable`, visibility to the trigger account,
  deleted) are re-checked at every dispatch and every `resume`, **inside the dispatch transaction** under the
  parent run lock (both `agents` rows `FOR SHARE` in id order), so a revocation never races a dispatch. Every gate's
  refusal is audited `subagent.refused` (target the refused agent, detail `gate`); the refusal names only the roster
  type.
- Plugin template skills match by name among the parent's selected org skills and its own agent skills; unselected
  or over-limit skills give English warnings in `subagent_started.warnings`.
- **Access to a child is decided through its parent** (ruling, batch 9 review I1): a sub-agent conversation, its
  events, stream and trajectory are readable by whoever can read the parent conversation (its owner; for
  trajectories the parent's agent owner or an org admin, and for an org agent child a non-admin
  must also still see that agent, final review m3). The dispatched org agent's owner gets 404. The sub-agent
  list keeps the row of an org-agent child whose agent the viewer can no longer see; opening it is 404.
- **Skill files in the shared sandbox** (ruling, batch 9 review I2): the conversation is the boundary. Skill files an
  org agent child loads are copied into the parent conversation's sandbox and stay there (§5.5); the allowlist
  warning on the agent page says so.

**Dispatch, waits and recovery (§7).**
- `subagents` waits get `runs.wait_expires_at` (0054), so `sweepOverdueSubagents` expires a wait whose timeout job was
  lost; the timeout job data is `WaitTimeoutData { runId, step }`. The wait sweep also re-enqueues a queued child
  whose enqueue was lost (`requeued`), fails a running child without job or lock `run.orphaned` (`orphaned`), and
  stops the active children of a terminal parent (`stopped`). A failed enqueue after commit is logged, not undone.
- A database error inside the dispatch transaction fails the parent run (an ambiguous commit must not become an
  `isError` result next to a live child).
- **A deadline or a stop in the tools node never suspends on sub-agents** (ruling, batch 10 review): the run ends at
  once and its children are stopped, with the stop text in its open `agent` calls; an already-ended child keeps its
  real result.
- **A stop in the tools node consumes pending interjections** (batch 10 review m8): after the tools node returns, the
  loop's `prepare` absorbs pending user messages before the model step aborts, so the run finishes `aborted` with
  `consumed` = the absorbed messages, as for a stop during any ordinary tool (the old suspend + `abortWaiting` route
  kept `consumed: null`).
- `RunAbort.request` takes a `detail` (`wait_timeout`); `abortedBy` is derived from `byAccountId === null` (offboarding
  and the parent's stop pass `null`, so such children report "stopped with this run"). Offboarding stops a removed
  member's child runs directly as well as through their parents. A queued child stopped during its first request may
  end with an aborted `assistant_message`; its terminal event is still `run_aborted`.

**Limits and tokens (§8).** `subagentLimits(db | trx, config, orgId)` reads the deployment setting
`subagentLimitOverrides` (per organization: concurrent 1–20, dispatches 1–500, tokens ≥ 10 000; set in the admin
console's organizations page) inside the locked dispatch transaction. The budget check sits in the loop's `prepare`
node, so it runs before a compaction call as well and a budget stop consumes no pending messages.

**Approvals and channels (§9).**
- A child approval's `conversationPath` is `/chat/<parent>?subagent=<child>`; the web opens the child from it (only a
  child of that conversation; anything else shows "The sub-agent cannot be opened.").
- IM cards for a child's approvals and questions are refreshed when the child finishes (on the parent's
  `subagent_finished`), not at the decision; a second click meanwhile gets "already handled". `subagent_waiting
  { kind: "connect" }` is web-only, not an IM card.
- A "this conversation" grant made on the parent also satisfies a template's `ask` for the same tool (one
  conversation from the person's view); grants are keyed by tool key, spec hash and connector.

**Sandbox (§10).**
- Every acquisition bumps `generation`; key TTLs are only extended (`KEEP_SHARED`), never shortened; renewal
  freshness counts from the send time; the intent TTL is max(4 × poll, 2 s); the `maxRunningMinutes` intent window
  is max(2 × poll, 1 s).
- A legacy busy marker sends the use path to the exclusive lease (and `killAll`), claimed only with the caller's own
  exclusive token. On the shared path `killTagged` runs whenever the provider has it; `killAll` only for the single
  shared holder of a provider without it. The holder record is refreshed before every exec. **New holders also
  write the old busy marker with the value `v2`** (ignored by new code) so an old replica that takes over after a
  new holder crashed still kills the leftovers (§10.8; the release notes say to finish the rolling upgrade
  promptly).
- **An instance is identified by its handle and the row's `created_at`**, not by `generation` or the handle alone
  (sandbox-docker reuses the instance name across rebuilds) (§10.10). Handles compare canonically (key order free, m9);
  every holder conversation remembers the instance it last used and is told once when it changed (m5).
- Path-lease busy text: "Another sub-agent is writing this file; wait a moment and retry." Attachment sync reads the
  marker without the path lease and takes it only when something needs copying; a path lease found lost on renewal
  aborts the write it guards. `killTagged` matches whole tags (`-<tag>-<uuid>( |$)`). The Docker restart fallback
  warns through `ctx.log`.
- Tests: the concurrent dual test runs two in-process `SandboxService`s with separate PG pools and Redis clients (a
  crash is the Redis connection dropping); serialization tests written before phase C pin `maxConcurrentCommands: 1`.

**APIs and progress (§14).** Progress is published from the loop's tools node (`LoopDeps.subagentProgress`) as SSE
`event: subagent_progress`. Usage with sub-agents is its own route, `GET …/conversations/:id/usage`, not a view field.
`GET …/subagents` rows are ordered by the child's **creation** (first dispatch), so a resumed sub-agent keeps its
position (its status and counts are its latest run's, its usage all runs'). `GET …/orgs/:orgId/agent-templates`
(the agent editor's list) needs `agents.create`; the organization's catalog item detail returns `agents` (the
template files).

**Replay and evals (§15).** Tests live in `test/evals/subagents-replay.test.ts` (and the org-agent case in
`org-agents.test.ts`). A child case always renders its logged definition; a candidate's instructions, model and
params apply on top (the model is the candidate's, else another version's only for an org agent child, whose params
then follow that version). `subagent_changed` compares without database reads: same version field by field;
another version: an org agent's version, `general` the parent's instructions, tools and roster entry, `inline` the
whole template, `plugin` the parent's tools, `orgSkills` and selection plus the template's **current** version (the
one DB read: a plugin upgraded after the case flags any changed candidate); an instructions override under another
version flags every source.

**Templates and Claude agents (§16).** Install order `agent_templates` before `skills` (a skills failure rolls the
templates back). The generated Claude template is `.capybara-generated/agents/<name>.md` (§16.4).
`agent_model_mapped` is reported only for non-alias values (`haiku` / `sonnet` / `opus` / `fable` / `inherit` map
silently; the tier shows in the `agent_imported` detail). A `Bash(...)` pattern in `tools` is dropped (mapping would
widen); in `disallowedTools` it disallows the whole tool; `*` is reported `agent_tools_inherited`, a pattern
`agent_tools_narrowed`. A translated plugin whose agents all fail imports with `agent_invalid` items and
`agents: []`. **Nested agent names** (batch 12 review m6): agents are collected recursively but named by file name, so
`agents/sub/x.md` becomes `<plugin>:x` (Claude Code includes the subdirectory) and same-named files in two
subdirectories are `agent_invalid` duplicates. The packer refuses duplicate names and more than 64 scanned
templates. **Phase wording** (batch 12 review m8): the web copy of `skill_needs_subagents` keeps "not supported until
phase D", the maintainer's decision 5; it changes when phase D ships.

**Web (§17), interim on today's conversation page (UI refresh B replaces it).** Rulings of the batch 14 review:
1. No `SubagentGroup` / `SubagentRow` design components, `/dev/ui` fixtures or screenshots: the interim UI composes
   existing design components (`SubagentRows.tsx`, `SubagentView.tsx`).
2. No avatar on org agent rows (no avatar component); the Inspector shows the agent's name with a link.
3. Running rows show no live duration.
4. Inline template editing covers name, description, instructions and tier; the other fields are kept as saved
   (API only).
5. The org catalog item lists agent templates (added after the review: the detail returns `agents`).
6. A sub-agent's approval card reads the approval on mount; a decision made elsewhere while the page is open shows
   after a reload (the parent log has no `approval_decided` for child approvals).
The upgrade dialog lists `agent_template` changes. A sub-agent question meant for someone else shows a line naming
the sub-agent.

**Final review fix wave.**
- **I1, follow-ups narrow to the current version** (maintainer ruling): a `resume` keeps the frozen
  instructions and model (replay), re-checks the roster type (`general` / inline by `findType`, plugin
  templates by template id; refused as unknown type otherwise), and intersects the frozen tools and
  `orgSkills` with the dispatching run's version (`general` / inline / plugin) or the org agent's
  current version (org agents, read by the in-lock gates). The result is `user_message.dispatch.narrowed`
  on the follow-up's task message; the child run (`childRunDefinition`) and `takeSnapshot` read it, so
  a child case of a follow-up replays with the narrowed set. Request building is unchanged (tools come
  from `model_call` spec hashes, skills from `skills_catalog`), so no `DriftReason` is needed; the
  zero-drift suites pass before and after. `runs.agent_version` of such a follow-up is the parent run's
  version, which is now also the version its tools were narrowed to.
- **I2, parent indexes**: `0055_subagent_parent_indexes.sql` (§18) adds
  `conversations_parent_conv_idx` and `subagent_dispatches_parent_conv_idx`, so deleting a
  conversation (an org, an eval set, an IM conversation) no longer scans both tables per row;
  `migration-0055.test.ts` pins that the cascade's generic plan uses them.
- **I3, missing `agent` results**: the wait sweep's `sweepOpenAgentCalls` (§7.5) repairs a terminal
  parent whose `agent` calls lack a `tool_result` (an old replica's abort, or a future bug in a new
  terminal path), idempotently, before `sweepChildrenOfFinished` stops its children.
- **m2, lock order**: the dispatch transaction (`commit`) locks the parent conversation row, then the
  parent run row, then (a follow-up) the child's row, the order of `finishRunIn`, `abortWaiting` and
  `cancelWaitsOfFinished`; a stop racing a dispatch commit no longer risks a 40P01.
- **m3, org agent child trajectories**: the trajectory of a child whose agent differs from its
  parent's also requires, for a non-admin, that the dispatched agent is visible to the viewer, the
  rule of the conversation read path (batch 9 ruling); the parent's trajectory is unaffected.
- **m4, step reminder**: the turn-limit reminder counts against the run's own step limit
  (`ModelStepInput.maxSteps` from `LoopContext.limits`), so a child whose template `maxSteps` is
  below `runtime.maxSteps` is warned before its forced wrap-up. Reminders are logged events, so
  replay reads them as before.
- **m7, a stopped queued child**: the run worker ends a `subagent` run that is still `queued` and has
  a stop marker (`RunAbort.requested`) as `run_aborted` right after taking its conversation lock,
  before the org run slot, and reports it to the parent; under a full quota a sub-agents wait
  timeout no longer leaves the parent waiting until the child wins a slot. Such a child has no
  `run_started`.
- **m8, a parent queued without a job**: the wait sweep's orphan repair (§7.5) also covers a `chat`
  run left `queued` with a resume job id (`run-…-resume-…`) whose replica died between
  `Waits.resume`'s update and its `queue.add`: past the grace period, with the lock free and the job
  gone, it is enqueued again under that job id (counted in `requeued`). Before, only the
  conversation's next message (`ensureRun`) repaired it.
- **m5, other holders of a rebuilt sandbox**: `withSandbox` takes the calling agent conversation
  (`holderConversationId`, a child's own; default the sandbox conversation) and records the instance
  it used (`capk:sandbox-seen:<conv>:<holder>` = the row's `created_at`, TTL
  `destroyAfterInactiveDays` + 1 day, best effort). A holder whose last instance differs gets
  `recreated: true`, so the parent or a sibling learns, on its next sandbox call, that its files are
  gone ("Sandbox was recreated; previous files are gone.", and its attachments are copied again).
  A holder that never used the sandbox before, or whose key expired, gets no notice (§10.10).
- **m9, instance identity**: `isInstance` compares handles with `canonicalJson`, so a jsonb round
  trip that reorders a multi-key third-party handle no longer breaks rebuild detection.

**Not built in phase C.** `context: fork` skills and manual skill invocation (phase D); recording the dispatch-time
authorization in `subagent_dispatched`; not copying an org agent child's skill files into the shared sandbox;
re-evaluating DB-dependent template narrowing (tool allowlists, skill names) for `subagent_changed`; a per-agent step
limit for long plans (R5); the `SubagentGroup` / `SubagentRow` design components, screenshots and avatars (UI refresh
B); live IM card updates at the moment a child's approval is decided elsewhere; an owner-facing audit view of
`subagent.dispatched` / `subagent.refused`. The live checklist (real superpowers, real model, Docker / E2B) has not been
run.

## Open questions for the maintainer

None. Both rounds are answered (see "Decisions of 2026-10-26").
