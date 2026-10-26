# Sub-agents (package ecosystem phase C)

- Date: 2026-10-26, written against `main` at `77de4ba` (phase B merged; UI refresh B not built).
- Status: draft for maintainer review. Parent spec: `2026-10-22-package-ecosystem-design.md` §11
  (direction and constraints), §12 (phase C acceptance), "Phase B as built" (pinned skills, the
  tool-name map, the translation report). Display side: `2026-10-22-ui-refresh-design.md` §5.6 and
  §5.9.
- Markers: **(decided)** restates a constraint the maintainer already set (ecosystem spec §11, UI
  refresh §5.6); **(designer's call)** is decided here on the maintainer's behalf and may be
  overturned in review. Items without a marker restate current code or AGENTS.md rules.
- Written in English (AGENTS.md "Language"). Model-facing text quoted here (tool description, errors,
  the sub-agent preamble) is the proposed exact wording; the builder may polish it, but it stays
  English and passes the `pnpm check` tool-design rules.

## 0. Summary

A builtin tool `agent` lets an agent hand a task to a **sub-agent**: a fresh agent with its own
context, started as its own run in its own **child conversation**, whose final reply comes back as
the tool result. The parent run suspends while its sub-agents work, exactly like a run waiting for an
approval (state in PG, no waiting in process, any replica resumes it), and several `agent` calls in
one model response run in parallel. Sub-agents come from three places: a copy of the parent itself
(`general-purpose`), templates written inline in the agent definition, and **agent templates**
installed from plugins, including Claude Code `agents/*.md` translated on import. A sub-agent's
tools and policies are the parent's, only narrower; its approvals go to the person who started the
conversation and show up in the parent conversation (and its IM channel); it shares the parent
conversation's sandbox; extension hooks fire for it with the parent named. Everything the child's
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
| S4 | "Never dispatch multiple implementation subagents in parallel (conflicts)" | nothing special: the model decides; the shared sandbox serializes commands anyway (§10) |
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
- G2. Parallel dispatch, foreground waiting, fresh context per sub-agent, follow-ups (§7, §8).
- G3. Multi-replica safe: the child run is its own queue job, the parent suspends and resumes through
  PG like an approval wait, every crash point has a recovery path (§7, §13) **(decided)**.
- G4. Permissions only narrow; approvals go to the conversation's starter **(decided)** (§9).
- G5. Limits per parent run: dispatch depth 1, concurrency, dispatch count, tokens counted against
  the parent **(decided)** (§8).
- G6. The child's log is the single source of truth for what its model saw; parent and child replay
  without drift (§15).
- G7. Agent templates from Capybara plugins and from Claude Code `agents/*.md`; `model` maps to a
  purpose, never a model id **(decided)** (§5, §16).
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
- N4. Org agents as sub-agents (dispatching another agent of the org with its own definition and
  owner). Phase C dispatches `general-purpose`, inline templates and plugin templates only; see §5.1
  **(designer's call)**.
- N5. Sandbox isolation per sub-agent (`isolation: worktree`, a separate sandbox). Sub-agents share
  the parent conversation's sandbox **(decided: shared by default)**; isolation is later (§10).
- N6. Concurrent commands in one sandbox (§10).
- N7. Claude skills with `context: fork` (open question Q2 recommends phase D).
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
- **Agent type**: what `subagent_type` names: `general-purpose`, an inline template's name, or a
  plugin template's `<plugin>:<name>`.
- **Agent template**: a reusable sub-agent definition (description, instructions, tool narrowing,
  model tier, step limit, preloaded skills). Inline in an agent definition, or an org **agent
  template** installed from a plugin.
- **Effective definition**: the `AgentDefinition` a child run uses, computed at the first dispatch
  from the template and the parent's definition (§5.3) and frozen in the child's log.

## 4. The tool contract

### 4.1 Name **(designer's call; Q1)**

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
`opus`; the tool-name map tells the model how they map (§16.5).

### 4.3 Description (model-visible)

Built per parent agent version at tool resolution time, so its spec hash changes when the roster or a
limit changes (logged per request as today: `model_call.request.tools[].specHash`, definitions in
`tool_specs`; replays read them by hash, so no new drift reason is needed for it):

```
Dispatch a sub-agent: a fresh agent with its own context that works on one task and returns its
final reply as this tool's result. The sub-agent sees only your prompt, not this conversation, so
include everything it needs and say what its final reply must contain. It shares your sandbox files.
You wait until it finishes. To run several at once, call this tool several times in the same
response (at most {maxConcurrent} at a time). Sub-agents cannot dispatch sub-agents or ask the user
questions. To send a finished sub-agent a follow-up while keeping its context, pass the agentId from
its result as resume.

Agent types (subagent_type):
- general-purpose: a copy of you with your tools and skills, for multi-step work.
- {name}: {description}
```

Inline templates are listed by name, plugin templates as `<plugin>:<name>`, in the order the owner
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

Other agents of the org are not dispatchable in C (N4): their owners, visibility, tools and grants are
their own, and "permissions only narrow" between two independent agents has no clean meaning yet.

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
}).strict().optional()
```

`InlineAgentTemplate` = the template fields of §16.1 (`name`, `description`, `instructions`,
`tools`, `toolPolicies`, `model`, `maxSteps`, `skills`), with `skills` as skill ids. The `agent` tool
is offered only when `{ kind: "builtin", name: "agent" }` is in `tools`; `subagents` without it is
kept but unused (the agent page warns). Saving checks (new error `agent.subagents_invalid`, 400, with
`details: [{ reason, … }]`): template ids exist in the org and are not deleted (`not_found`); inline
names match `^[a-z0-9][a-z0-9-]{0,63}$`, are unique and are not `general-purpose` (`invalid_name`,
`duplicate`); inline tools are keys of this agent's tools (`tool_not_selected`); inline skills are
selected by this agent (`skill_not_selected`); roster ≤ 20 (`too_many`).

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
sub-agent's model.

## 6. Child conversations

### 6.1 Shape

A child is a row in `conversations` with:

- `kind = 'subagent'` (the `CHECK` widens from `('chat', 'eval')`);
- `org_id`, `agent_id`, `account_id` = the parent's (the parent's agent owns it for visibility,
  deletion and "always" grants; the conversation owner is the parent's owner, so the existing
  owner-only access rule applies unchanged);
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
     template: { source: "general" | "inline" | "plugin", id?: string, version?: number, plugin?: string },
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

Then the usual run events. A follow-up appends another `user_message` (with `dispatch`) and the
next child run absorbs it like any message.

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
(audit), `trigger_account_id` = the parent run's trigger account, `trigger_seq` = the task message's
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
  the remaining children (§12) so the parent can go on.
- Time spent waiting counts into `waited_ms`, so it is not part of the parent's
  `runtime.maxRunSeconds` (the same as approvals) **(designer's call; Q4)**. The parent's total work
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

## 8. Parallelism, limits and accounting

### 8.1 Parallel dispatch

All `agent` calls in one assistant message are dispatched in the same tools-node pass, so they run
concurrently on any replicas with free worker slots, each holding its own org run slot (the parent's
slot is released while it waits, so children never deadlock with their parent). Per parent run at
most `subagents.maxConcurrentPerRun` children are active; the calls of a response beyond that get
the refusal of §4.5 at once **(designer's call: refuse, not queue)**. Queuing would need a dispatcher
that starts the next child when one finishes; refusing is simpler and the model adapts.

### 8.2 Limits **(decided: depth 1, concurrency and token caps; numbers designer's call, Q4)**

| Config (`subagents.*`, deployment; org overrides in org settings like `runConcurrencyOverrides`) | Default | Bound |
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

- **Tools and policies**: §5.3. `decidePolicy` for a child call reads the parent agent's current
  version (as for the parent) and then applies the child overlay; `fixedAsk` rules (shared agents'
  `skill_write`) do not arise (no `skill_write`).
- **Identity**: `accountId` = the parent run's trigger account; personal connector credentials,
  `requiredRole` and role escalation (R1) behave exactly as for the parent. `agentId` = the parent's
  agent, so "always" grants are shared with it.
- **"Approve for this conversation"** granted on a child's approval is stored against the **parent
  conversation** (`conversation_tool_grants.conversation_id` = parent), and grant lookup for a child
  checks the parent conversation **(designer's call)**: from the person's view the sub-agents work in
  their conversation, and parallel children asking for the same tool are approved once.
- **Approvals and questions go to the starter** **(decided)**: child approvals are ordinary
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

## 10. Sandbox sharing and locking

**Shared by default (decided).** A child uses the **parent conversation's** sandbox:

- `BuiltinCallContext` gains `sandboxConversationId` (= the parent conversation for a child, the
  conversation itself otherwise); every `withSandbox`, attachment sync and sandbox status call uses
  it. The `sandboxes` row, the Redis lock `capk:sandbox:<parent>`, the busy marker
  `capk:sandbox-busy:<parent>`, the `generation` fence, idle suspension and destruction are all
  unchanged and keyed by the parent.
- **Locking is unchanged: one command at a time per sandbox.** Parallel children and the parent (a
  non-`agent` call in the same step) queue on the lock for up to `sandbox.lockWaitSeconds` (75 s),
  then get the existing `sandbox.busy` tool error ("busy with another command; wait … and try
  again"). The fence still protects lifecycle writes, and the takeover `killAll` after a crashed
  holder stays correct because there is only ever one holder. This fits superpowers (implementers run
  one at a time; parallel reviewers mostly read files) **(designer's call; Q3)**. Concurrent
  commands would need a shared/exclusive lock and per-holder busy markers so that a takeover does not
  kill a live sibling's command; that is later work (N6).
- **Attachments** of the parent conversation are synced into the shared sandbox when a child first
  uses it (sync keyed by the sandbox conversation), so a child can read files the person attached.
- Each child's `read_tool_output` archive is its own (keyed by the child conversation).
- Deleting the parent's agent destroys the parent conversations' sandboxes as today; children have
  none of their own.

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
| Template uninstalled or changed while a sub-agent exists | none: the definition is frozen in `subagent_started` | a follow-up keeps the frozen definition |
| Parent agent loses a tool mid-run | the child's call to it is `unavailable` (live resolution) | normal |
| Tier purpose unmapped or its model gone | the parent's model is used, `tierFallback: true` | the admin maps the purpose |
| Org run slots full | children wait in the queue (`QUOTA_FULL_DELAY_MS`) | normal |
| Rolling upgrade: a parent with a dispatched child resumes on an old replica | the old pipeline does not know `agent` and writes "unknown tool" | accepted for the rollout window (§23 R6); child jobs never reach old replicas (§7.4) |
| Token cap reached mid-child | child ends with `budget` | parent gets the partial reply |

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
  a step replay of a child case with a candidate (another parent agent version or another template
  version) whose effective definition differs from the logged one; the request still renders the
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

- New tables `agent_templates` (`id`, `org_id`, `name`, `catalog_item_id` provenance,
  `current_version`, `deleted_at`, unique `(org_id, catalog_item_id, name)`) and
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
`.capybara-generated/agents/<name>.json` (the source file is never rewritten, §8.1 of the parent
spec). `agent_needs_subagents` is retired; new report codes:

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
  installed templates to select (with source plugin), and inline templates (FormSection list);
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

All expand-only (old code never writes the new values; widened checks are safe on old replicas).
Zero-downtime rules apply (0.1.0 is released before phase C).

## 19. Config, error codes, SDK

- Config (`docs/config.md` regenerated): `subagents.maxConcurrentPerRun`,
  `subagents.maxDispatchesPerRun`, `subagents.maxTokensPerRun` (all `hot`); org overrides in org
  settings.
- Kernel purposes: `subagent_fast`, `subagent_standard`, `subagent_capable`.
- Error codes: `agent.subagents_invalid` (400), `conversation.read_only` (409).
- New event types: `subagent_started` (child), `subagent_dispatched`, `subagent_waiting`,
  `subagent_finished` (parent); `user_message.dispatch`; `run_finished.reason` gains `budget`.
- SDK: `PluginManifest.agents: PluginAgentRef[]`, `parseAgentTemplate`, `AGENT_TEMPLATE_LIMITS`,
  `HookScope.parent`, `UsageReportPayload.parent`; API report regenerated and a changeset bumping
  `@capybara-hq/plugin-sdk` (`check:sdk-api`, `check:sdk-api-changeset`); package schemas
  regenerated.
- Skills to update: `writing-tools` (the `agent` builtin), `writing-plugins` (agent templates,
  Claude agents), `replay-evals` (§15), `writing-extensions` (hook `parent`), `writing-sandbox-providers`
  (shared sandbox key).

## 20. Phases and tasks (outline for the plan)

| Task | Content | Main files |
|---|---|---|
| C1 Schema and events | migration; event schemas; request building skips new events; `subagent_started` read path; zero-drift fixtures before and after | `migrations/00NN_subagents.sql`, `conversations/events.ts`, `runtime/context/build.ts`, `db/kernel-schema.ts` |
| C2 Effective definition | `subagents` field and checks; `general-purpose` / inline resolution; narrowing; tier purposes | `agents/definition.ts`, `agents/agents.service.ts`, new `runtime/subagents/definition.ts`, `models/purposes.ts` |
| C3 Dispatch and resume | the `agent` builtin; tools-node path; limits and counters; `subagents` waits; resume condition; child finish hook; `cap-kernel-subagent-runs`; sweeps | `tools/builtins/agent.ts`, `tools/pipeline.ts`, `runtime/waits.ts`, `runtime/run-worker.ts`, `runtime/run-queue.ts`, new `runtime/subagents/*.ts` |
| C4 Permissions, sandbox, hooks | policy overlay; parent-conversation grants; `subagent_waiting` and channel cards; `sandboxConversationId`; hook scope and usage report | `tools/policy.ts`, `tools/approvals.service.ts`, `channels/outbound.ts`, `tools/builtins/sandbox/common.ts`, `runtime/hook-calls.ts`, `runtime/usage-report.ts`, plugin-sdk `hooks.ts` |
| C5 Cancellation | cascade on parent terminal / waiting abort; child abort; wait timeout | `runtime/waits.ts`, `conversations/conversations.service.ts`, `runtime/run-finish.ts` |
| C6 APIs | sub-agent list; child access; read-only; usage sums | `conversations/*` |
| C7 Templates in plugins | SDK parser and manifest; catalog read and review; org install / upgrade / uninstall / rollback; tables | plugin-sdk `plugin-manifest.ts`, new `agent-template.ts`, `catalog/plugin-*.ts`, `tools/pack-plugin` |
| C8 Claude translation | `agents/*.md` translation and report codes; the tool-name map line | `catalog/claude/translate.ts`, `report.ts`, `runtime/context/claude-tools.ts` |
| C9 Replay and evals | `subagent_changed`; snapshot `subagent`; parent full-run replay test; child step and full-run replay; trajectory links | `evals/*` |
| C10 Web | components, conversation page, Inspector view, agent page, review, purposes, i18n, screenshots | `packages/design`, `apps/web` |
| C11 Acceptance | the superpowers end-to-end test; dual-replica test; live checklist | `packages/kernel/test/subagents/*`, fixture update |

C1–C6 are the runtime and can merge behind no flag (the tool is opt-in per agent). C7–C8 can run in
parallel with C3–C6 after C2.

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

- **R1 Shared sandbox contention**: parallel children with long commands hit `sandbox.busy` after
  75 s and waste steps retrying. Mitigation: the tool description says files are shared; superpowers
  runs implementers one at a time; concurrent exec later (N6, Q3).
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

## Open questions for the maintainer

1. **Tool name.** `agent` (Claude Code's `Agent`, inputs named as Claude's), or `subagent` /
   `dispatch_agent`? **Recommended: `agent`.**
2. **`context: fork` skills** (parent spec §8.3 placed them in phase C). In Claude Code they are
   mostly user-invoked commands that run in a forked sub-agent. **Recommended: defer to phase D**
   (manual invocation), keep `skill_needs_subagents` as "runs as a sub-agent when invoked manually;
   phase D".
3. **Parallel children and the sandbox.** Keep one command at a time per sandbox in C (shared files,
   serialized commands, `sandbox.busy` after 75 s), or build concurrent commands (shared/exclusive
   lock, per-holder takeover) now? **Recommended: keep serialized in C**; revisit with real usage.
4. **Limits and the clock.** Defaults 4 concurrent / 50 dispatches / 5 M tokens per parent run, and
   time spent waiting for sub-agents not counted toward the parent's `runtime.maxRunSeconds` (like
   approvals). **Recommended: as stated.**
5. **Follow-ups (`resume`) in C.** superpowers' fix rounds 1–3 use it but fall back to a fresh
   implementer without it. **Recommended: include it** (the child log already holds the context; it
   is a second `user_message` and run).
6. **Org agents as sub-agents.** **Recommended: not in C** (general-purpose, inline and plugin
   templates only); decide after real use whether "dispatch my colleague's agent" is wanted and what
   narrowing means between two owners.
