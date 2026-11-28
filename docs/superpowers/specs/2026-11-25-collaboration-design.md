# Collaboration: projects, items, assignment and event automations

Status: draft for review (2026-11-25); the four open questions were decided the same day (§10). Decisions the maintainer made in the brainstorm are marked
*decided*; calls marked *my call* are open to review.

Two deliverables:

- **Kernel:** scheduled tasks become **automations** with a second trigger family, **events** that
  extensions emit; a keyed conversation mode (one conversation per subject); a person's standing
  acceptance of work addressed to them; extension inbox items; a run lifecycle hook.
- **Plugin `collab`** (in `capybara-hq/plugins`): projects, items (requirement / task / bug),
  workflows with gates, assignment to a responsible person plus an executing agent, decisions,
  artifacts, a board, tools, and role agent templates (product / engineering / QA).

## 0. Why

Agents in Capybara today work one conversation at a time, started by the person who types. Teams
want role agents (product, engineering, QA) that pick up work from a shared tracker, hand it to the
next role, and pull people in only where a person must decide. Nothing in the kernel lets an
extension start that work: `ctx` has no way to start a run or post into a conversation, and the only
non-human trigger is time (scheduled tasks).

## 1. What the others do (summary)

| | Shape | What we take |
|---|---|---|
| Linear for Agents | agents are workspace members; an issue is *delegated* to an agent while a person stays the assignee; the agent's thoughts, actions and questions appear in the issue's activity | person + agent assignment; agent activity on the item |
| GitHub Copilot coding agent | assigning an issue starts it; review comments are new input to the same session | assignment is the trigger; follow-ups continue the same conversation |
| Jira automation | rules: trigger, conditions, actions | subscriptions as trigger + filter + action, not one feature per event |
| MetaGPT / ChatDev | roles hand off structured artifacts (PRD, design, test report) under an SOP | handoffs carry artifacts, not chat history |
| Capybara scheduled tasks | unattended runs act as the creator, pre-approved tools, no silent waits, delivery to chats | the whole run path, reused (§4) |

## 2. Goals, non-goals, anti-goals

Goals:

- A project holds items of configurable types (requirement, task, bug by default), each with a
  workflow of statuses; items have children, links, comments, artifacts and an activity log.
- An item is assigned to a **responsible person** (required, one) and optionally an **executing
  agent** (zero or one) plus watchers (*decided*).
- Being assigned starts the agent in **the item's conversation**: one conversation per item and
  executing agent; later events about that item continue it (*decided*).
- Assignment is accepted automatically by default; a person may set rules that require their
  confirmation (*decided*).
- Anyone may subscribe their agent to item events (created, changed, status reached, commented,
  mentioned, decision answered, closed) with filters, delivered to the item's conversation, a fixed
  conversation, or a new one each time.
- Subscriptions live in the kernel as event automations, so other plugins (GitHub, channels) can
  emit events later through the same path (*decided*).
- Agents ask people through **decisions** (question, options, a recommendation, blocking or not),
  and move items through **gates** that only a person may pass.
- Agents create and update projects and items through tools.

Non-goals (this version):

- Agents as principals with their own accounts, connectors and devices (*decided*: a separate
  design before 0.1.0; this one reserves a `principal` field).
- Agent-only assignment (needs principals).
- A reviewer field (*decided*: a gate names its confirmer instead).
- Sync with Jira / Linear / Lark Projects / GitHub Issues (a later phase; *decided* the plugin
  owns its tracker).
- Multi-person conversations.

Anti-goals (a failure even if it works):

- An agent's run silently waiting on something nobody sees.
- An agent passing a gate, or approving its own request.
- Someone outside a project driving another person's agent.
- Agents triggering each other in an unbounded loop.

## 3. Concepts

- **Project**: members (people) with a project role (`owner`, `member`, `guest`) and an optional
  function label (product / engineering / QA / any text) used for default assignment.
- **Item type**: requirement, task, bug by default; per project, editable. Each type has a
  **workflow**.
- **Workflow**: statuses, each in a category (`backlog`, `todo`, `in_progress`, `review`, `done`,
  `canceled`), optional allowed next statuses, an optional **gate**, and an optional **default
  assignment** (person + agent) applied when an item enters it.
- **Item**: key (`<PROJECT>-<n>`), type, title, description (Markdown), status, responsible person,
  executing agent, watchers, priority, labels, parent, custom fields.
- **Gate**: a status that only a person may move an item into, and who confirms (the responsible
  person, the project owner, a named member, or anyone with a function label). An agent may
  *request* the transition; the request is a decision addressed to the confirmer.
- **Decision**: a question from an agent to a person on an item: options, a recommended option and
  why, blocking or not, addressee, deadline and escalation. Answering it is an event.
- **Artifact**: a versioned file or link on an item (PRD, design, test report, PR URL).
- **Event**: an extension's report that something happened to a **subject** (here: an item), with
  facts the kernel can filter on. Kernel concept, §4.
- **Automation**: the kernel's renamed scheduled task. Trigger: time (`cron`, `once`) or `event`.
- **Acceptance**: a person's standing answer to work addressed to them and an agent of theirs:
  `auto` (default), `confirm`, `off`. Kernel concept, §4.4.
- **Item conversation**: the keyed conversation of (automation, subject); for assignment, of
  (person, agent, item).

## 4. Kernel: event automations

### 4.1 Rename and shape

Scheduled tasks become automations (*decided*: rename the tables, routes, tools and UI in this
change, since nothing before 0.1.0 needs compatibility). Today's time pipeline is
untouched; events add a second entry point that ends in the same claim and start code
(`schedules/fire.ts`).

`automations` (today `scheduled_tasks`) gains:

- `trigger` jsonb: `{ kind: "cron" | "once", ... }` as today, or
  `{ kind: "event", source: "<plugin>", types: string[], filter: EventFilter }`.
- `mode`: today's `new` | `conversation` | `chat`, plus **`subject`** (one conversation per subject,
  §4.5).
- `origin`: `person` (made by its owner) or `acceptance` (made by the kernel from an acceptance
  rule, §4.4).
- `principal` jsonb, today always `{ kind: "member", accountId }` = `account_id`; reserved for agent
  principals.

`automation_runs` (today `scheduled_task_runs`): the unique key becomes `(automation_id,
trigger_key)`, where `trigger_key` is the tick time for time triggers and the event id for events.
Time-only columns (`scheduled_for`, the `missed` skip reason) stay nullable for event runs.

`next_run_at` is null for event automations, so the time scanner never selects them. An event
automation runs only on its events: "run now" and trial runs are refused for it
(`automation.run_now_unsupported`), and the web hides both actions. Its `expires_at` is enforced
as a time automation's is (the org's `defaultExpiryDays` applies when none is given; the
dispatcher passes an expired one over and the scan ends it, `expired`).

### 4.2 Emitting events

`ctx.triggers.emit(event)` (permission `permissions.triggers: { emit: ["item.created", ...] }`):

```ts
interface TriggerEvent {
  orgId: string;
  type: string;                 // declared by the plugin; no dots in the stored key: plugin + type
  subject: { kind: string; id: string; title: string; url?: string };
  facts: Record<string, string | number | boolean | string[]>; // filterable, declared per type
  summary: string;              // English, what happened, at most 4 KB; model-visible
  dedupeKey: string;            // idempotency per plugin
  cause?: { call: ToolCallContext } | { handle: string } | { accountId: string };
  audience?: { accountId: string; agentId: string }; // a directed event (§4.4)
}
```

- **Not transactional with the plugin's write** (the plugin's `ctx.db` cannot reach kernel tables).
  A plugin that must not lose an event writes it to its own table in its transaction and emits from
  a `ctx.queue` job; the kernel dedupes on `(plugin, dedupeKey)`, so retries are safe.
- `emit` inserts a `trigger_events` row (org-scoped, RLS policy in the same migration) and owes a
  `trigger-dispatch` job (kernel maintenance queue, job id `trigger-dispatch-<eventId>`) through the
  outbox in the same kernel transaction.
- `cause.call` is the tool call context the plugin's tool received; the kernel reads the run from
  the pipeline's call facts (`callScopeOf`, refusing a context the pipeline did not make), checks
  the run is in the org and derives the chain depth (§4.7). `cause.accountId` is the person behind
  a UI action or route.
- `cause.handle` carries a call's cause into a `ctx.queue` job (*decided* 2026-11-28): in the tool
  call the plugin asks `ctx.triggers.causeOf(call)` (verified as `cause.call`), the kernel stores a
  `trigger_cause_handles` row bound to the org, the plugin and the run for 24 hours and returns its
  id; the job's payload carries the id, and `emit` accepts it only unexpired, for an event of that
  org from that plugin, deriving the run and depth as for `cause.call`. An expired handle, a
  handle of another org or plugin, and an unknown id are `invalid_event`. The trigger event sweep
  deletes expired handles.

### 4.3 Declaring sources: `trigger-source@1`

A plugin that emits events provides the `trigger-source@1` extension point (`multi`, org-scoped):

- `events`: per type, a localized name, the fact schema (JSON Schema of flat facts, each marked
  `filterable`), and whether it may be directed.
- `visible(orgId, accountIds, subject)`: which of these people may see the subject (batch). The
  kernel calls it when it matches automations, so a member removed from a project stops receiving
  its events without the kernel knowing projects.
- `subjectLink(orgId, subject)`: optional, for the web's link.

The automation form builds its filter UI from the fact schema; `EventFilter` is a conjunction of
`{ fact, op: "eq" | "in" | "contains", value }` on filterable facts only.

### 4.4 Directed events and acceptance

Assignment is a **directed event**: `audience` names the person and the agent the work is for.

- The dispatcher looks for that person's automations with `origin = acceptance` for (source,
  agent). If none exists, it reads the person's acceptance rule for the source (default `auto`,
  *decided*; org setting `automations.directedDefault` may change the default) and, for `auto`,
  creates the acceptance automation: mode `subject`, no grants, `unattendedAsk: wait`, owner = the
  person. The person sees it in their automations and may edit grants, switch it to `confirm` or off.
  Its prompt states only the mechanism (events the source directed to the person and agent,
  delivered by their acceptance rule; decide from each event's type, subject and summary what, if
  anything, is expected), since a directed event need not be an assignment (`item.unassigned`, an
  answered decision): what happened is the event block's (§4.6), never the prompt's.
- `confirm`: the kernel posts an inbox item "work offered" (new kernel kind `automation_offer`,
  with push) with accept / decline; accept starts the run. Decline (*decided*) posts an inbox
  notice to the person who caused the event (`cause.accountId`, or the owner of the causing run)
  and fires `run.lifecycle` with `offer_declined` (§4.8), so the plugin marks the assignment as
  declined.
- `off`: nothing runs; the plugin shows the assignment as not accepted.
- The kernel checks at fire time, as today, that the person may use the agent (`AgentLookup.get`).

Why `wait` rather than today's `fail` default for acceptance automations: the person was just told
the agent took the item, so an ask outside the grants reaching them as an approval (web, card,
push) is expected, not a silent wait; `fail` would make a fresh acceptance useless until grants are
configured. Person-made event automations keep the org's `unattendedAsk` default.

### 4.5 The subject conversation mode

`automation_conversations (org_id, automation_id, subject_kind, subject_id, conversation_id)`,
unique on the first four. The first fire for a subject creates the conversation
(`conversations.create`, with `conversations.subject` set) and the row in one transaction under
the automation row lock, so the mapping is atomic and two first fires of one subject make one
conversation; that fire and every later one queue their message into it (`ConversationQueue.add`),
so one conversation never runs two event runs at once.

`conversations.subject` jsonb (`{ source, kind, id, title }`, nullable) links a conversation to its
subject, for the side panel (§6.5) and for the plugin to list an item's conversations through
`ctx.conversations.bySubject(orgId, subject)` (ids, owner, agent, state, last activity; never
content).

### 4.6 What the model sees

The rename (§4.1) leaves the event log's stored names alone (`user_message.schedule`,
`run_started.trigger: "schedule"`, `execution: "scheduled"`): logs are history, read back by the
web and by replay, and are never rewritten (as migration 0063 did for tool keys). Event fires add a
new marker beside them.

An event fire posts a user message with an `automationEvent` marker (beside today's `schedule`
marker in `InternalMessageOptions` and the `user_message` event): the automation's name and prompt,
the event type, the subject title and link, and the plugin's `summary`, in a block the run header
states is reported by an extension and written by people who are not necessarily the owner. Coalesced
events (§4.7) are listed in order in one message, at most 20 of them: the first 5 and the latest
15, with a `- … and <n> more events (not shown)` line between them (`omittedEvents` on the marker);
every coalesced event still belongs to the run. The header change carries a `DriftReason`; the
zero-drift fixtures run before and after.

### 4.7 Guards

- **Self-trigger:** an event whose cause is a run of agent A for person P never fires P's
  automations on agent A (*decided*: an agent's own changes do not trigger its own subscriptions).
- **Chain depth:** `runs.trigger_event_id` records the event a run started from; an event caused by
  a run gets depth = that event's depth + 1. Past `automations.maxEventDepth` (org setting, default
  8) the event is stored, not dispatched, and the owners of the last automation in the chain get an
  inbox notice.
- **Coalescing:** events for the same (automation, subject) within `automations.coalesceSeconds`
  (default 30) become one fire. Only the delivery that opens a window owes a job: a delayed
  BullMQ job with the per-window id `<coalesceJobId(automationId, subject)>-<firstEventId>`
  (`automation-coalesce-<automationId>-<subjectKey>-<firstEventId>`); later events of the window
  find its deliveries waiting and owe nothing. The job reads every waiting delivery for the pair.
  A window whose job was lost for good is taken over by the next event of the pair, or by the
  trigger event sweep, which also deletes settled events after `automations.eventRetentionDays`
  (platform config, default 30). The sweep takes a window as lost only when its newest waiting
  delivery is past the window and no outbox row of the pair is pending (a window the dispatcher
  just opened is never flushed early); it owes a lost window's job again with a back-off by the
  age of the pair's newest waiting delivery and gives up, logging, once that delivery is 24 hours
  old (the newest window's age, so an old window given up on never hides a newer lost one).
  A cause handle records the run's depth and trigger account when it is made, so retention
  deleting the run's trigger event within the handle's life does not restart the chain. The sweep
  also deletes expired cause handles (§4.2), expires work offers left open for seven days (§4.4),
  and deletes inbox items closed or past their expiry more than `inbox.retentionDays` ago
  (platform config, default 30; §4.9).
- **Rate:** `maxRunsPerHour` applies per person (the runs of the owner's automations in the last
  hour, time and event runs together); add `maxEventRunsPerSubjectPerHour` (default 12).
- **Overlap:** an event run never waits for its automation's previous run (its events would be
  lost): `new` gives each run its own conversation; `conversation` and `subject` queue it into the
  conversation, whose queue serializes the runs.
- **Visibility:** an automation fires only if `visible()` (§4.3) admits its owner.
- Org admins may switch event automations off per source.

### 4.8 Run lifecycle hook

New observe hook `run.lifecycle` for runs whose conversation has a `subject` from the same plugin,
owed in the transaction that changes the run and delivered after commit. The phases:

- `started`: a run was created (queued);
- `waiting`: the run suspended on a person (`waitingOn` `approval` or `input`; waits on sub-agents
  are not announced);
- `resumed`: that person's wait cleared (answered, decided or timed out) and the run continues
  (one per wait, owed where the run leaves `waiting`);
- `finished`, `failed`, `aborted`: the run completed, failed, or was stopped by a person or the
  kernel;
- `offer_declined`, to the plugin that emitted a directed event the kernel did not run, with
  `reason`: `off` (the person's rule), `declined` (the person declined the offer), `paused` (the
  acceptance automation is paused or ended), `expired` (the offer stayed open seven days and the
  sweep expired it) or `undelivered` (the sweep gave up on the pending event after 24 hours).

Compact runs are never announced. The plugin shows "agent working / waiting on you / done" on the
item. At least once; the plugin treats it as a hint.

### 4.9 Personal inbox items

Extension inbox items are a `ctx` capability (*decided*): the kernel's inbox (站内信) is the one
place a person is told about things, and extensions post into it rather than building their own.

Today's org notices are admin-only and dismissed org-wide, so personal items get their own table
`inbox_items` (org, account, source `kernel` or a plugin, kind, title, body, link, actions, state,
expiry). The kernel writes it too (a declined offer, §4.4; a depth stop, §4.7).

`ctx.inbox.post / resolve` (permission `permissions.inbox`): an item for one person with a title,
a short body (each a single string or `{ zh, en }`, stored as given and shown in the reader's
language, like the action labels), a link (the plugin's page) and up to three actions; an action names one of the
plugin's UI actions (`ctx.ui.action`), which the kernel calls with the person who clicked. The
inbox lists them under the plugin's name; push follows the person's push settings. Items have an
expiry. Channel cards for them are a later phase.

As built: kernel items have the kinds `automation_offer`, `automation_offer_declined` and
`automation_depth_stopped` (no actions; the web writes their copy by kind). A plugin item links only
under `/p/<plugin>/`, carries at most three actions (each idempotent) and a `dedupeKey` (one open
item per key and person), and expires after 30 days by default (90 at most); an offer's item
expires after 7 days. Closed and expired rows are swept after `inbox.retentionDays` (platform
config, default 30). Dismissing is `inbox.item-dismiss`; clicking an action is a human-only route.

### 4.10 As built (collaboration kernel)

- **Cause handles.** `ctx.triggers.causeOf(call)` stores a row in `trigger_cause_handles` (org,
  plugin, run, depth, trigger account); the handle is valid for 24 hours and accepted only for the
  same org and extension. A queued emit with `cause: { handle }` keeps the chain depth.
- **Event retention.** Trigger events are deleted after `automations.eventRetentionDays` (platform
  config, default 30), except an event with an open offer; an event still pending after 10 minutes
  is dispatched again by the sweep and given up (`undelivered`) after 24 hours.
- **Acceptance.** `automation_acceptance` holds the person's rule per source (`auto`, `confirm`,
  `off`; no row follows `automations.directedDefault`); `automation_offers` holds offers
  (unique per event; `open`, `accepted`, `declined`, `expired`). An offer counts as open only
  while it is `open` and younger than 7 days; the sweep marks older ones `expired` (resolving
  their inbox item) and retention then treats them as closed. The
  acceptance automation (`origin = acceptance`) has a fixed trigger, agent and mode; people edit
  its name, grants and pause state. It does not count against the per-member task limits.
- **Personal rules.** A person sets their rules in the 接收规则 ("Acceptance rules") sheet of the
  automations page (`/automations?rules=1`, opened from the page head while a source directs
  events to them); acceptance automations carry the same tag in the list. The org default sits in
  the org's automation settings. `automations.acceptance-set` is a Platform
  operation declared `personOnly`: the ask is always the person's, never decided by a review model
  or a full-access profile, and refused in an unattended run.
- **`run.lifecycle`.** Phases `started`, `waiting`, `resumed`, `finished`, `failed`, `aborted` and
  `offer_declined` (§4.8). The payload carries ids only (org, account, agent, run, conversation,
  subject, `waitingOn` `approval` or `input` for `waiting` and `resumed`); `offer_declined` has
  `reason` `declined`, `off`, `paused`, `expired` or `undelivered`, the event's `eventId` and
  emitter's `dedupeKey` (to tell a stale decline from one for a newer event), and no run or
  conversation. The
  plugin must be enabled in the org when the notice is owed and again when it is delivered.

## 5. Plugin: data (`plugin_collab`)

| Table | Holds |
|---|---|
| `projects` | key, name, description, archived |
| `project_members` | account, project role, function label |
| `item_types` | per project: name, icon, workflow id |
| `workflows`, `statuses` | statuses with category, order, allowed next, gate rule, default assignment `{ accountId?, functionLabel?, agentId? }` |
| `items` | key, type, title, description, status, responsible account, executing agent, priority, labels, parent, fields jsonb, version |
| `item_watchers`, `item_links` | watchers; `blocks` / `relates` / `duplicates` |
| `comments`, `activity` | comments; every change, with actor `{ accountId }` or `{ accountId, agentId, runId }` |
| `artifacts` | item, kind, name, version, `ctx.storage` key or URL, author |
| `decisions` | item, asker (run), addressee, question, options, recommendation, blocking, state, answer, deadline |
| `event_outbox` | events written in the item's transaction, emitted by a `ctx.queue` job (§4.2) |

Every row carries `org_id`; every query filters it.

## 6. Plugin: behavior

### 6.1 Assignment

- The responsible person must be a project member; the agent must be one the responsible person may
  use (the picker reads `ctx.agents.usableBy(orgId, accountId)`, new: id, name, avatar).
- Assigning (or reassigning) with an agent emits a directed `item.assigned` to `{ person, agent }`
  (§4.4). Removing the agent emits `item.unassigned` to the old pair; the run in progress finishes
  its current turn and is not aborted (*decided*); its next tool call that writes to the item fails
  with "no longer assigned".
- A notice reaches the responsible person whoever assigned it (`ctx.inbox`), with "stop" (unassign
  the agent) and "reassign".
- Assigning yourself never asks.

### 6.2 Handoff

Entering a status with a default assignment reassigns the item (the function label resolves to the
project's member with that label; ties go to the project owner to pick). Each reassignment is an
ordinary assignment (§6.1), so acceptance applies.

### 6.3 Gates and decisions

- `collab_item_transition` into a gated status creates a decision of kind `gate` for the confirmer
  instead of moving the item. Confirming is a plugin UI action whose route caller is a person's
  session; tools never confirm, and the asker's own owner confirming is allowed (it is a person).
- `collab_decision_ask`: the item shows "waiting on <person>"; `ctx.inbox.post` notifies; blocking
  decisions tell the model to stop work that depends on the answer, non-blocking ones to proceed
  with the recommendation. An answer emits a directed `decision.answered` to the asking pair, which
  lands in the same item conversation.
- Deadlines: a `ctx.queue` delayed job (deterministic id) reminds, then escalates to the project
  owner.

### 6.4 Tools

All registered through `ctx.tools.register`, keys `plugin__collab__<name>`:

`project_list`, `project_create`, `item_search`, `item_get`, `item_create` (also children),
`item_update`, `item_transition`, `item_assign`, `item_comment`, `item_link`, `artifact_attach`,
`decision_ask`, `decision_list`.

- A tool acts as the run's person: it sees only that person's projects.
- Writes record the actor `{ accountId, agentId, runId }`.
- Unattended runs may not create or widen automations (unchanged kernel rule); `item_assign` to
  someone else is a fixed ask in unattended runs (*decided*: never grantable), so an agent cannot
  fan work out to other people's agents without a person.

### 6.5 UI

- `org.page` "Projects": project list, board (columns by status, drag to move; gated columns open
  the gate request), list view, item detail (description, children, artifacts, decisions, activity
  with agent actions, the item's conversations), project settings (members, types, workflows,
  gates, default assignments). An L2 client component built from `@capybara-hq/plugin-client` design
  re-exports (schema views have no board).
- `conversation.panel` and `conversation.properties.section` in a conversation with a `collab`
  subject: the item card, its status and open decisions.
- `agent.detail.section`: items the agent is executing.
- Automations page (kernel): event automations show the source, types and filter; acceptance
  automations show as "accepts work from Projects".

### 6.6 Role templates and skills

The plugin ships agent templates `product`, `engineer`, `qa` (`agents/*.md`) and skills that teach
the item workflow (PRD and test plan shapes, when to ask a decision, how to hand off). Members
create private agents from them as today.

## 7. Worked flow

1. A person creates requirement CAP-12 "Export reports as PDF" with responsible = PM Li, agent =
   Li's product agent. Acceptance `auto`: the kernel creates Li's acceptance automation and the item
   conversation; the product agent drafts a PRD artifact and asks two decisions; Li answers them on
   the inbox; the answers continue the conversation.
2. The agent requests "ready" (gated, confirmer: project owner Wang). Wang confirms on the board.
3. "Ready" has default assignment engineering + engineer agent: Zhang + Zhang's engineer agent
   accept automatically; it writes a design, creates three tasks assigned to itself and Zhang, works
   in Zhang's device, attaches PR links, moves tasks to "testing".
4. "Testing" defaults to QA: Chen + Chen's QA agent run tests, file bug CAP-19 linked to the task,
   assigned to Zhang + engineer agent; the bug lands in a new item conversation for CAP-19.
5. Fixed, verified, closed; when every child is done, CAP-12 moves to "acceptance" (gated, Li);
   Li accepts.

## 8. Phases

| Phase | Content |
|---|---|
| K1 | rename to automations; event trigger, `trigger_events`, dispatcher, `trigger-source@1`, `ctx.triggers.emit`, subject mode, guards, automation marker + DriftReason |
| K2 | directed events and acceptance (`automation_offer` inbox kind), `ctx.inbox`, `ctx.agents.usableBy`, `ctx.conversations.bySubject`, `run.lifecycle` hook, Platform operations |
| P1 | plugin data, tools, project / board / item pages |
| P2 | assignment, handoff, gates, decisions, panel slots, templates and skills |
| Later | channel cards for extension inbox items, external tracker sync, agent principals |

## 9. Tests (outline)

- Kernel unit: filter evaluation, chain depth, self-trigger rule, coalescing key.
- Kernel integration: emit → dispatch → subject conversation created once, second event queued into
  it; acceptance `auto` / `confirm` / `off`; visibility refusal; rate and depth limits; dedupe on
  retry; zero-drift fixtures with the new marker.
- Container (dual replica): two replicas dispatching the same event fire once; coalescing across
  replicas.
- Plugin: tools against a fake host, gate confirmation refused from a tool call, handoff on status
  entry, decision answer delivered to the asking conversation.

## 10. Decided during review (2026-11-25)

1. Scheduled tasks are renamed to automations in this change (§4.1).
2. A declined offer notifies the person who caused the event through the kernel inbox, and the
   plugin through `run.lifecycle` (§4.4); inbox items are a `ctx` capability (§4.9).
3. Removing the executing agent lets the run finish its current turn (§6.1).
4. `item_assign` to another person is a fixed ask in unattended runs, never a grant (§6.4).

## AGENTS.md rules touched

- **Extensions:** new `ctx.triggers`, `ctx.inbox`, `ctx.agents.usableBy`,
  `ctx.conversations.bySubject`, `ctx.people`; new permission keys `triggers`, `inbox`, `agents`,
  `conversations`, `people`; new extension point
  `trigger-source@1` (`multi`, org-scoped); new observe hook `run.lifecycle`. Hooks still observe
  only.
- **Multi-replica discipline:** dispatch is an outbox job; coalescing is a BullMQ delayed job with a
  deterministic id without `:`; no in-process state.
- **Migrations:** renamed and new kernel tables with `org_id` ship their RLS policies in the same
  migration; applied migrations untouched.
- **Runtime and replay:** the automation marker and event block are new model-visible input with a
  `DriftReason`.
- **Platform tool:** automation routes change shape (event trigger, acceptance rules); operations and
  parity follow.
- **Web UI:** automation form and inbox gain kinds; zh copy says 自动化 / 智能体.
- **Public API reports:** SDK changes need `pnpm gen:sdk-api` and a changeset on
  `@capybara-hq/plugin-sdk`.
