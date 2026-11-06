# Background sub-agents, `SendMessage` and the agent map

Status: implemented, kernel and web agent map (2026-11-07; see "Decisions made during
implementation" at the end); was: design, 2026-11-06. Amends the sub-agents spec (`2026-10-26-subagents-design.md`, "phase C")
and reuses the wake rules of the background Bash spec (`2026-11-05-background-bash-design.md` §3).
Decisions taken with the user in the brainstorm of 2026-11-06 are marked **(decided)**; calls made by
the designer are marked **(designer's call)**; everything else is left to the builder (§11).

## 0. Why

Sub-agents today are foreground: the parent run suspends on a `subagents` wait until every child it
dispatched has finished. While children work, the person cannot talk to the root agent (their
messages only queue), and the root agent cannot change a child's direction: `resume` is refused while
the child runs. Depth is fixed at 1.

The user works this way in Claude Code every day: the root agent splits a plan across four sub-agents
running in the background, keeps discussing with the person, and when the discussion changes what
sub-agent B should do, the root sends B a message and B picks it up at its next step. The "agent
map" shows the whole tree (seen three levels deep in practice) with each agent's model, time and
tokens; clicking an agent shows a live summary of its tool calls, and from there its full transcript
or a stop button. This spec brings that to Capybara.

## 1. What Claude Code does (the model this follows) **(decided: follow Claude Code's mechanism)**

- `Agent` runs the sub-agent in the background and returns its id at once; the caller is notified
  when it completes.
- `SendMessage { to, message }` sends to a sub-agent by name or id; a background sub-agent can send
  to `"main"` (its caller). Delivery never interrupts a tool: the message is queued and drained at the
  receiver's next tool round. Sending to a finished agent resumes it from its transcript.
- A sub-agent has a `SubagentHandback` tool ("Report delivered to your caller"): it hands a report
  to its caller and may keep working afterwards. Only sub-agents have it; the root has no caller.
- A person never talks to a sub-agent directly. They talk to the root, and the root relays. The
  transcript of a sub-agent is read-only.
- A finishing sub-agent (like a finishing background Bash task) wakes an idle caller.

## 2. Goals, non-goals, anti-goals

**Goals**

- G1. Background dispatch: `Agent` returns at once; the parent run goes on, or ends its turn and
  talks to the person, while children run **(decided)**.
- G2. Parent → child messages while the child runs, absorbed at the child's next step; to a finished
  child, the message resumes it with its context **(decided)**.
- G3. Child → parent: `SendMessage` to its own parent (a note, non-blocking) and `SubagentHandback`
  (a report, the child may continue) **(decided)**.
- G4. Every report, message and finish of a child reaches the parent as an absorbable event and wakes
  an idle parent, under the same rules as a background Bash finish **(decided: wake)**.
- G5. Nesting up to three levels below the root by default (depths 1–3: child, grandchild,
  great-grandchild), as Claude Code (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, default 3), changeable
  per org **(decided, 2026-11-06: align with Claude Code)**.
- G6. The agent map: a dialog with the tree, a live per-agent summary and the read-only transcript,
  in both themes (§9) **(decided)**.
- G7. Multi-replica safe and replayable: everything any model sees is in a log; nothing waits in
  process; replays never dispatch, send or wake.

**Non-goals**

- N1. People messaging a sub-agent. Child conversations stay read-only for people (phase C N2 stands)
  **(decided)**.
- N2. Messages between siblings or across levels. A child talks only to its own parent and its own
  children **(designer's call, accepted)**.
- N3. Session tools for the model (search conversations, rename, post to another conversation by
  id). The user asked about them in the same session; they are a separate project that can reuse the
  delivery path built here.
- N4. ~~The conversation timeline restyle.~~ **Withdrawn (decided by the user during the build).** The IN / OUT look
  meant the open-transcript mockup only; there is no restyle project. Transcripts render with
  today's timeline component and its collapsed Thread (§9.4).
- N5. Sandbox isolation per sub-agent (phase C N5 stands).

**Anti-goals**

- A1. Never interrupt a running tool to deliver a message.
- A2. Never hold a promise, timer or in-process map across a child run (phase C A1 stands).
- A3. Never let a message reach a model without being in that model's conversation log.
- A4. Never let a wake or a message loosen anything: approvals still go to the person who started
  the run, tools still only narrow.
- A5. Never let a model reach a conversation that is not its own parent or child through
  `SendMessage`.

## 3. Terms

- **Root**: the person's conversation (`kind = 'chat'`). **Child**: a conversation of `kind =
  'subagent'` with `parent_conversation_id`. **Depth**: root 0, its children 1, their children 2.
- **Agent id**: the child conversation id, as phase C's `agentId` already is.
- **Report**: what a child hands back (`SubagentHandback`, or its final reply as the fallback).
- **Note**: a `SendMessage` from a child to its parent.
- **Tree**: a root and all its descendants.

## 4. The model's surface

All text below is model-facing and English; exact wording is the builder's, checked by the tool
design check.

### 4.1 `Agent` (changed)

- Always background **(designer's call: one mode, like Claude Code here)**. The result is immediate:
  the agent id plus a sentence that the result will arrive as a notification and that the agent can
  keep working or end its turn.
- `resume` is removed (pre-0.1.0, no compatibility layer); `SendMessage` replaces it.
- Offered to an agent whose depth < `subagents.maxDepth` (with the default 3: the root and depths 1
  and 2 have it, depth 3 does not).
- The per-call refusals of phase C §4.5 stay (limits, unknown type, …), with a new one at the
  depth limit for safety even though the tool is not offered there.
- **A child's roster (decided, 2026-11-06)**: a child that may dispatch uses the configuration of
  the agent it belongs to. A child that is an org agent (phase C §5.5) uses that agent's own
  `subagents` block (roster, allowlist, limits narrowed by the tree's); a `general-purpose`, inline
  or plugin-template child inherits its parent's roster. The frozen definition in
  `subagent_started` therefore keeps a `subagents` block (phase C froze none). The org allowlist,
  `dispatchable` and visibility gates are checked at every dispatch at every level, for the person
  the dispatching run acts for (§7).

### 4.2 `SendMessage` (new builtin)

Input `{ to: string, message: string }`. `to` is the agent id of one of the caller's own children,
or `"parent"` in a child. Anything else is refused with an actionable error that lists the valid
targets. Result: delivered (with the target's state: running, or idle and now resumed) — never the
target's reply.

- Offered to every agent that has `Agent` (to reach its children) and to every child (to reach its
  parent).
- Default policy `allow` **(designer's call)**: it only moves text inside one tree the person
  already started.

### 4.3 `SubagentHandback` (new builtin, children only)

Input `{ message: string }`. Delivers a report to the parent; the child keeps its turn and may go on
working **(decided: as Claude Code)**. Several handbacks are allowed. Result: "Report delivered to
your caller."

### 4.4 Preamble

The phase C sub-agent preamble changes: the final reply is no longer "the only thing returned"; the
child should hand back with `SubagentHandback` when done, may send notes to its parent with
`SendMessage`, and may receive messages from its parent while working.

### 4.5 What the parent's model sees

Each delivery to a parent is one model-visible event in the parent's log, rendered like an
interjection: who sent it (agent id and description), the kind (report, note, finished with status)
and the text. On finish: if the child handed back at least once, only a short status line (no
repeated report); if it never did, its final reply is the report **(designer's call)**. Today's
`subagent_finished` is not model-visible (the reply was the `Agent` call's `tool_result`); the
delivery is a **new** model-visible event, and `subagent_finished` stays a display-only event, so old
logs keep replaying unchanged (the reconstruct fixtures prove it).

## 5. Delivery

### 5.1 Parent → child

`SendMessage` appends a `user_message` to the child's log, with the existing `dispatch` record
extended to say it came from the parent agent (not model-visible; the web renders it as the
"message from <parent>" bubble). Then:

- child run active: the child's next step absorbs it like a person's interjection
  (`absorbedUpToSeq`), at the next model call, never mid-tool **(decided)**;
- child idle (its last run ended): a new child run starts from that message, as a phase C follow-up
  does today, with the frozen definition.

### 5.2 Child → parent

`SendMessage to: "parent"`, `SubagentHandback` and the child's run finishing each append one
absorbable event to the parent's log (§4.5). Then:

- parent run active: absorbed at its next model call;
- parent idle: wake (§5.3).

### 5.3 Wake **(decided: wake, like background Bash)**

A delivery to an idle conversation starts a run under the background Bash §3 rules, generalized to a
second event kind: the 60 s coalescing window and its delayed job, the paused-queue check, the "can
the trigger account still send" check, `run_started.trigger` with a new value and `triggerSeq` at the
boundary event, `consumed_seq` moving past it. The wake run's trigger account is the trigger account
of the run that dispatched the child (approvals and usage go to that person, §7). For a child, the
background Bash checks apply to the **root** conversation: the trigger account must still be able to
send to the root, and a paused root queue holds wakes of the whole tree **(designer's call)**. Children are woken the
same way when their parent sends to them, and by their own background Bash tasks (today only chat
conversations wake; the builder decides how far that rule widens, §11). Config: reuse
`runtime.wakeOnBackgroundTask` or add a sibling; builder's call.

### 5.4 Removal of the foreground wait

The `subagents` wait kind (`Waits`, `isSettled`, the resume condition's third `NOT EXISTS`, the wait
sweep's sub-agent clauses) has no caller from `Agent` any more. `context: fork` skills (phase D)
dispatch a sub-agent before any model call and wait for its report; the builder either keeps the wait
for that path only or moves fork onto the wake path. Either way the fork's observable behaviour (the
report rendered as `skill_fork_result`) must not change.

Required with the removal, not optional:
- the wait sweep's "children of finished parents are aborted" rule (`waits.ts`) is deleted: with
  background dispatch a finished parent run with active children is the normal case; a child is
  aborted only when its root conversation is deleted or someone stops it (§6);
- `subagent_finished.status` loses `timed_out` (its only source was the subagents wait timeout),
  unless the fork path keeps that wait;
- the per-run limit wording in the `Agent` description and config descriptions follows §6.

## 6. Depth, limits, accounting

- `subagents.maxDepth` counts levels **below** the root, as Claude Code: default 3 (depths 1–3), org
  override in `subagentLimitOverrides` **(decided)**. Bound: 1–5, where 1 means no nesting (only the
  root dispatches) **(designer's call)**. Concurrency stays at phase C's default 4 per parent (Claude
  Code allows 20) because children share one sandbox **(designer's call)**.
- A `SendMessage` that resumes an idle child counts as a dispatch (as phase C follow-ups do) and its
  run takes a concurrency slot; when no slot is free the send is refused with an actionable error,
  never queued (phase C §8.1's refuse-not-queue) **(designer's call)**.
- Concurrency: `maxConcurrentPerRun` becomes per conversation (active children of one parent at
  once), since a parent's runs now end while children work **(designer's call)**.
- Dispatch and token caps keep their numbers but count per **tree**, against the root's current
  budget window, so a chain of wake runs cannot multiply them **(designer's call; the builder picks
  the window — e.g. reset when a person sends a message — and records it)**.
- Tokens of every descendant count toward the root conversation's usage (phase C §8.3 extended
  through the chain).
- Stopping **(decided, 2026-11-06, as Claude Code)**: the conversation's stop button stops only the
  root's current run; background children keep working. Stopping an agent in the map (level 2 or 3)
  stops it and all its descendants. Deleting the root conversation stops the whole tree.

## 7. Approvals

A descendant's approval goes to the trigger account of the run that dispatched (or last messaged)
it, inherited down the chain: a child run's trigger account is its dispatching run's, a wake run's is
the trigger account of the run whose event woke it, so it always ends at the person whose message
started that branch of work (in an IM conversation with several speakers, that speaker)
**(designer's call)**. Approvals show in the
**root** conversation (the person only looks there), not only in its direct parent
(`subagent_waiting` propagates up the chain). Grants stay stored against the root conversation.

## 8. Events, APIs, replay

- New and changed events: the parent-side delivery event (report / note / finished), the
  `dispatch` extension on the child's `user_message`, `run_started.trigger` for a sub-agent wake. Event
  names are the builder's.
- APIs: the tree of a root with each node's status, agent type, model, start / end, tokens, tool
  call count and latest text; a node's recent tool calls (name + display summary) and background
  tasks; the existing events API and SSE for a child's full transcript. Live updates over the
  existing streams (`subagent_progress` grows into what the map needs).
- Replay: the new absorbable event joins `user_message` and `background_task_finished` in
  `absorbedUpToSeq`; wake runs are seeded from `run_started.triggerSeq`; full-run replay uses recorded
  results of `Agent`, `SendMessage` and `SubagentHandback` and never dispatches, sends or wakes. Any
  new `DriftReason` follows the replay-evals rules. The zero-drift fixtures run before and after.

## 9. The agent map (web) **(decided in the mockups)**

Mockups (open in a browser): `docs/superpowers/specs/2026-11-06-agent-map/` —
`agent-map-dark.html`, `agent-map-light.html` (level 1), `agent-detail.html` (levels 2 and 3). The
icons in them are characters for the mockup only; the build uses `Icon`.

### 9.1 Copy

Chinese UI copy calls an agent 智能体 (智能体图, 子智能体) **(decided)**. No "main agent" or "level N"
labels: position and lines show the hierarchy **(decided)**.

### 9.2 Level 1: the tree

- A dialog over the conversation page, opened from the conversation (the sub-agent group in the
  stream and a title-bar entry while the conversation has sub-agents; exact entry points are the
  designer's call for the design-system change).
- Header: title (智能体图 / Agent map), "N 个智能体 · M 个运行中 · 点击查看详情", close.
- Columns left to right by depth; the root is vertically centred on its children; standard elbow
  connectors from each parent to the vertical centre of each child.
- Every node has the **same height**; line 1: status dot + description (bold, ellipsis); line 2:
  **model · time · tokens**, nothing else, one line, ellipsis only when it truly does not fit (full
  text on hover) **(decided)**. Nodes are wide enough that the usual line 2 never truncates.
- Status is only the dot colour (running: pulsing accent; waiting: warn; completed: ok; failed:
  fail; stopped: faint), with a legend at the bottom **(decided: no status words)**.
- Bottom left, under the root column: the root's own background tasks (status, `Bash`, description,
  duration), as Claude Code places them **(decided)**. A child's background tasks show in its level 2
  only.

### 9.3 Level 2: one agent's summary

Replaces the dialog content; ← returns to the tree. Live, at the granularity of tool summaries:

- head: status dot, description, close; then status · agent type · model · background; "spawned by
  <parent>" (a link to that node); time · tokens;
- the agent's latest text;
- collapsible sections: the task (the dispatch prompt), its background tasks, tool calls (N) with the
  newest first, the running one with a pulsing dot and a clock; each row is the tool name and its
  display summary (`Bash` description, `Read` path and range, …);
- footer: "Open transcript" and "Stop" (running only; stops descendants too). A finished agent shows
  only "Open transcript".

### 9.4 Level 3: the transcript

The **same timeline component** as the conversation page, inside the dialog, without the composer
**(decided)**: the task as the first bubble, messages from the parent as bubbles labelled with their
sender, `SubagentHandback` and other tools as ordinary tool blocks, live. The footer is a read-only
status line ("子智能体只读 · 不能和它对话，请让 <parent> 转达"), context use and Stop while running.
Built from `apps/web/src/lib/timeline.ts` like every timeline, with the conversation page's
collapsed Thread for tool calls, not IN / OUT blocks shown open (N4 is withdrawn).

### 9.5 In the conversation stream **(decided, 2026-11-06: as Claude Code)**

Each `Agent` call in the stream is a tool block: the header is `Agent` + the task description; the
body is `IN` with the prompt (two lines, ellipsis, expandable). Under it, while the child works, one
live status line: a pulsing dot, "后台运行中：<the child's current tool summary>" / "Working in the
background: <summary>", and an action that opens that agent in the map (level 2), the way Claude Code
says "type /tasks to see its transcript". When the child ends, the line becomes its final state
(status dot, "完成 · <time> · <tokens>" / failed / stopped) and the action stays. The line is fed by
`subagent_progress` (latest tool summary) and the tree. It replaces today's per-call row inside
`SubagentGroup`; whether the group header stays is the builder's call.

### 9.6 Design system

New design components and their state lists and reference blocks in `packages/design`, a section in
`docs/design/spec.md`, visual baselines through `visual-update`, and the web rules of AGENTS.md
(template + components, no styles in `apps/web`, queries through the query cache, i18n zh and en).
The existing sub-agent right panel and stream group stay; the builder decides whether the right panel
is superseded by level 2.

## 10. Failure modes to cover

- A message to a child whose run ends between the check and the append: it starts a new child run.
- Several children finishing together: one wake (coalescing window), all deliveries absorbed by it.
- A wake whose trigger account lost access: no run; the events stay for the next person message.
- A root deleted while children run: the tree is stopped (phase C §12 sweeps extended to the tree);
  a parent run that merely ends leaves its children running (§6).
- Crash between append and enqueue: the existing sweeps re-enqueue (job ids deterministic, no `:`).
- Rolling upgrade: a replica without this change must not take children's jobs or wake runs; the
  builder states the release note, as phase C §7.4 did.

## 11. Left to the builder

Event and field names; the delivery event's rendering text; whether `context: fork` keeps a wait
(§5.4); the budget window of §6; whether children wake on their own background tasks and under which
config key (§5.3); the map's entry points and whether level 2 supersedes the right panel (§9.2, §9.5);
the plan's phases (kernel first, then design components, then web).

## Decisions made during implementation

The builder's choices for §11 and the rulings of the build that change behaviour, one line each.

- Events: `subagent_delivery` (`report` / `note` / `finished`, model-visible, absorbable),
  `run_started.trigger: "subagent"` with `triggerSeq` at the delivery, `user_message.dispatch.kind`
  `"task"` / `"message"` (absent = `"task"`).
- Fork skills keep the foreground `subagents` wait (§5.4): only `for_skill` dispatches count for
  `timed_out`, `Waits.expire` and the overdue sweep; a fork invocation's child gets no message tools
  and does not deliver.
- Budget window (§6): a person-triggered root run opens it; every other run of the tree carries
  `runs.budget_run_id` = that run, where tokens and dispatches are counted.
- Wakes (§5.3): children wake on their parent's messages and on their own background Bash finishes,
  under the one switch `runtime.wakeOnBackgroundTask`, with the queue and access checks on the root.
- Every terminal run of a child (dispatched, restarted by `SendMessage`, or a wake run) delivers a
  `finished` delivery with that run's final reply, keyed on the child run.
- A tree stop never wakes the stopped ancestors: the `aborted` delivery is still written (marked)
  and absorbed at that conversation's next run. A stopped sub-agent (last run `aborted`) is never
  woken at all: a message, task finish or delivery that reached it before or during the stop is
  parked until its parent starts it again (`Agent`, `SendMessage`), so a descendant's report that
  landed just before the stop cannot restart the stopped branch.
- Stopping a child conversation stops all its active background tasks, not only the stopped run's;
  a tree stop stops those of every sub-agent it covers, idle ones included.
- A run's budget window is its own `runs.budget_run_id`: a wake run of a sub-agent checks and counts
  its tokens on the root's current window, not on the window of the run that first dispatched it.
- A sub-agent's trajectory is authorized by its root conversation's agent at every depth (never by
  the direct parent's, which below an org agent's child is that org agent).
- Wake runs and continuation runs (a resumed or restarted run) start without a concurrency check: a
  continuation keeps the slot it already holds, and refusing a wake would lose the event that woke
  it.
- A fork child's later runs (restarted by `SendMessage`) behave as a background child's: they
  deliver their finish and get the message tools; only the fork's own dispatched run is foreground.
- Background-task listing and stop cover the whole tree (grandchildren's tasks run in the root's
  sandbox).
- Unpausing the root's queue re-evaluates pending wakes of the whole tree.
- Conversation access for a sub-agent conversation is "the root is the viewer's chat" (same org,
  owner, not deleted, agent visible), so the map reaches every depth.
- A run restarted by `SendMessage` acts for the sender's trigger account (§7), and holds a
  concurrency slot like a dispatched one.
- The agent tree API carries no per-node latest text; level 2 reads it from the child's own events.
- Map entry points: an "智能体图 / Agent map" action in the `SubagentGroup` header and a title-bar
  icon while the conversation has sub-agents; the state lives in the URL hash (`#agents`,
  `#agents=<id>`, `#agents=<id>/transcript`); the sub-agent right panel stays for now.
- The map's tree scrolls horizontally inside the 1100 px dialog at four columns (depth 3), keeping
  the node width.
- The admin sub-agent limits dialog gains a `maxDepth` field, and its "per run" labels are corrected.
- The design `UserBubble` takes an optional sender label (a parent's message in a transcript), and
  the sub-agent row's "后台" label is omitted for a fork invocation's (foreground) child.
- N4 is withdrawn (see §2): level 3 uses the collapsed Thread.
