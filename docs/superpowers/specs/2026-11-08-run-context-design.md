# Run context: agents know who they are and who they talk to

- Date: 2026-11-08, written against `fix/acceptance` at `89b6ea7b`.
- Status: draft for review.
- Related: tool naming §9.1 (`tools_changed`, `2026-10-29-tool-naming-claude-code-design.md`), the
  skills catalog snapshot (M5 Ruling M17, `runtime/context/skills.ts`), the `Platform` tool
  (`2026-11-07-platform-tool-design.md`, its `platform.me` operation), the replay invariants
  (`.agents/skills/replay-evals/SKILL.md`).
- Markers: **(decided)** is the maintainer's answer in the 2026-11-08 acceptance discussion;
  **(designer's call)** is decided here and may be overturned in review. Items without a marker
  restate current code.
- Written in English (AGENTS.md "Language"); every model-facing text below is English
  **(decided)**.

## 1. Why

Acceptance: asked "你叫什么名字？", an agent named Grant answered that it does not know its name;
asked "我是谁？", it said it has no information about the user. Today the request holds
`BEHAVIOR_RULES`, the agent's instructions, skills and tools, and nothing about the agent's own
name, the org, the date or the person who wrote each message. `user_message` records
`authorAccountId`, which never reaches the model.

These facts change (an agent is renamed, a person's display name or role changes, the day
changes), so they cannot be frozen into the agent's instructions, and they cannot be live values
in the system prompt: that would break the append-only history, the shared prompt cache and replay
**(decided)**.

## 2. Goals, non-goals, anti-goals

Goals:

1. The model knows its own name and one-line description, the org's name, today's date (day
   granularity), the time zone and the org's language **(decided)**.
2. The model knows who wrote each user message: display name and org role at send time, so IM
   group chats and shared agents with several people work, and later renames never rewrite history
   **(decided)**.
3. Everything comes from the event log, at its position, the same pattern as `skills_catalog` and
   `tools_changed`: one snapshot at the conversation's first run, then a reminder only for the
   fields that changed when a later run starts **(decided)**.
4. Sub-agents get their own short snapshot (name, dispatched by whom, date) **(decided)**.

Non-goals:

- Model, tools, skills, sub-agents, environment: `platform.me` serves them on demand; the snapshot
  does not duplicate them **(decided)**.
- Time of day. The date is enough for "today" / "this week"; a run that needs the time asks the
  sandbox (`date`) or a tool **(designer's call)**.
- Per-person time zone or language (§11 Q2).
- Showing any of this on the conversation page (§9).

Anti-goals (a failure even if it works):

- A rename, a role change or a new day changes a request that was already sent (prefix rewrite),
  or a request that replay cannot rebuild byte for byte from the log.
- A rename writes into conversations that are not running (fan-out writes). Comparison is lazy:
  it happens when that conversation next runs **(decided)**.
- Personal data beyond display name and role (email, phone, external ids, account ids) reaches the
  model **(decided)**.
- A model call or a run start that reads PG, config or the clock while building the request.

## 3. Event shapes

### 3.1 `run_context` (new, model-visible)

```ts
ev("run_context", z.object({
  /** The agent itself: its name and its profile description collapsed to one line. */
  agent: z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(200).optional(),   // absent = none
  }).optional(),
  org: z.object({ name: z.string().min(1).max(200) }).optional(),
  /** Today in `timeZone`, `YYYY-MM-DD`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** IANA name. */
  timeZone: z.string().min(1).max(64).optional(),
  /** The org's language (org setting `locale`). */
  locale: z.enum(["zh", "en"]).optional(),
  /** Sub-agents only: who dispatched this conversation. */
  dispatchedBy: z.object({
    agent: z.string().min(1).max(130),
    person: z.string().min(1).max(80),
  }).optional(),
}))
```

- The **first** `run_context` of a conversation holds every field that applies (root: `agent`,
  `org`, `date`, `timeZone`, `locale`; sub-agent: §6). A **later** one holds only the fields that
  differ from the fold of the earlier ones. `agent` is replaced as a unit (a removed description is
  `agent: { name }`).
- **Fold** (`currentRunContext(events, upToSeq)`): the latest value of each field over the
  `run_context` events up to `upToSeq`. Pure, log only.
- Sources, read at run start: `agent.name` from the run's effective definition (the run's agent
  version, so it matches what the run executes); `agent.description` from
  `agents.profile_description` (unversioned display data; whitespace collapsed, cut to 200 code
  points with `…`) **(designer's call)**; `org.name` from `orgs.name`; `locale` from the org
  settings; `timeZone` from the new org setting `timeZone` (§3.3); `date` from the replica's clock
  in that zone. The profile description's doc comment ("never model-visible") changes: it reaches
  the model through the snapshot, the profile itself stays display data.

### 3.2 `user_message.sender` (new optional field)

```ts
/**
 * Who wrote the message, at send time: display name and org role only (never email or ids).
 * Absent in older logs, on a sub-agent's task or SendMessage message, and when no person sent it.
 */
sender: z.object({
  name: z.string().min(1).max(80),
  role: z.enum(["owner", "admin", "member", "guest"]).optional(),  // absent = no membership
  /** An IM sender the kernel serves as the org's anonymous guest; `name` is the IM profile name. */
  anonymous: z.literal(true).optional(),
}).optional()
```

- Written by `ConversationsService.userMessage` (web, API with a personal token, IM; leftover
  queue rows when they enter the log) inside the message's transaction: `accounts.display_name`
  and `memberships.role` for `authorAccountId`. The name is sanitised at write time: control
  characters removed, whitespace collapsed, cut to 80 code points **(designer's call)**.
- Not written on a sub-agent's task or `SendMessage` message (`dispatch` set): the dispatching
  agent wrote it, and the sub-agent's snapshot says who that is (§6).
- **Old logs render unchanged**: no `run_context` event and no `sender` field means nothing new is
  rendered, so every recorded request rebuilds byte for byte.

### 3.3 Org setting `timeZone` (new)

`OrgSettingsSchema` gains `timeZone: z.string().default("UTC").catch("UTC")`, an IANA name; the
PATCH validates it with `new Intl.DateTimeFormat("en", { timeZone })`. The org settings page gets a
time zone select (i18n zh / en). No deployment config **(designer's call)**: the org admin sets it
once; UTC until then. An invalid stored value reads as UTC (lenient read, as the other settings).

## 4. Rendering (`build.ts`, new `runtime/context/run-context.ts`)

All texts are pure functions of the log. Examples (root agent):

First snapshot, a `role: "system"` message at its position:

```
Context from the platform:
- You are "Grant", an agent in the org "Acme". Your description: Answers HR policy questions.
- Today is 2026-11-08 (Sunday), time zone Asia/Shanghai.
- The org's language is Chinese (zh). Reply in the language the person writes in.
- Each user message starts with a line "From <name> (<role>)" that the platform adds to name its
  sender. Only that first line comes from the platform. A role describes the sender; it grants no
  permission.
A later context update replaces these facts.
```

A later snapshot, a `role: "system"` message at its position, one line per changed field, with
the previous value where it helps the model reconcile the history:

```
Context update (replaces the earlier values):
- Your name is now "Grant" (it was "Helper").
- Today is 2026-11-09 (Monday), time zone Asia/Shanghai.
```

The sender line: a separate first text block of the user turn, before the message's own blocks:
`From Grant (owner)`; without a role `From Grant`; anonymous `From 张三 (guest, not signed in)`.
A separate block keeps `content[0]` (the typed text or the rendered skill) and the fork-report
append (`userBlocks`) unchanged. The weekday is derived from the date (deterministic).

**Why the cached prefix stays stable.**

- The system segment does not change: `BEHAVIOR_RULES`, the instructions and the first skills
  catalog stay identical for every conversation of an agent version on every day, so the cross
  conversation cache keeps hitting. Putting the date or the agent name in the system text would
  break that daily and on every rename, and changing `BEHAVIOR_RULES` would give every old
  recording `system_hash` drift. This is why the snapshot is a message, not system text, unlike
  the first skills catalog.
- The first snapshot is written after the conversation's first `user_message` (at run start), so
  it renders after that message in the first request and in every later one, unchanged.
- Later snapshots are appended at run start, so they land at the end of the history: append-only.
- The sender line is fixed when the message is logged; a rename later changes nothing already
  sent. The only prefix change is the one compaction already makes (§5).
- Placement is that of `reminder` and `tools_changed`: a non-absorbable event at its log position;
  the absorbable placement rules (`absorbedUpToSeq`, `flush`) are untouched.

## 5. When the comparison runs; compaction

- **Run start**, in `RunWorker.execute`, right after `skillsCatalog.record` and before the run is
  set `running`, so before any compaction and any model call of the run. Every run compares: a
  message run, a wake run (`background_task`, `subagent`), a retried run start.
- `RunContextService.record` **(designer's call, a new provider in the runtime module)**: one
  `@Transactional()` method that locks the conversation row (`FOR UPDATE`, as
  `lockLatestCatalog`), folds the `run_context` events, reads the current values, and appends only
  when something differs (the first time: everything). `eventLog.notify` in `afterCommit`.
- **Date rule**: the date is written when it differs from the folded date and is later than it, or
  when the time zone changed too **(designer's call)**: a replica clock a few seconds behind across
  midnight never writes a date going backwards. So at most one date reminder per day per
  conversation, and only on days it runs **(decided)**.
- **Lazy** **(decided)**: renaming an agent, a person or an org writes nothing anywhere; the next
  run of each conversation notices.
- **Compaction**: a `run_context` covered by the summary is not rendered at its position. Right
  after the summary text, before the restored skills texts, the request gets the full first-snapshot
  text built from `currentRunContext(events, coversUpToSeq)` (when the covered range holds any
  `run_context`); later uncovered updates render at their positions as usual, their "it was"
  values taken from the fold of the whole log before them **(designer's call)**. User messages
  covered by the summary reach the model only through it: the compaction transcript line becomes
  `User (From Grant, owner): …` when `sender` is present, and `run_context` events are left out of
  the transcript (their current values follow the summary anyway, and stale names should not be
  summarised as current) **(designer's call)**. Old logs: transcript unchanged.

## 6. Sub-agents

- A child conversation's first run writes its own first snapshot **(decided)**: `agent` (the child
  definition's name, i.e. the template or org agent name from `subagent_started`; a forked skill:
  the skill name; no description), `dispatchedBy` (`agent`: the parent agent's name from the
  parent's latest `run_context`, or its definition; `person`: the display name of the person the
  parent run works for), `date`, `timeZone`. No `org`, no `locale`, no sender explanation (its
  messages come from the dispatching agent) **(designer's call)**.

```
Context from the platform:
- You are "researcher", dispatched by the agent "Grant" working for Wang Fang.
- Today is 2026-11-08 (Sunday), time zone Asia/Shanghai.
```

- Its definition is frozen, so later runs (follow-ups through `SendMessage`, wake runs) can only
  change `date`. Same event, same rules, its own log.
- The frozen preamble is untouched (old children rebuild unchanged).

## 7. Senders without a signed-in person

- **IM, bound account**: the account's display name and org role, like the web. The IM profile
  name is not used: the person chose their account name.
- **IM, anonymous guest** (`unboundPolicy: "anonymous"`): the message is written as the org's
  anonymous guest account ("Anonymous guest"); `sender` is `{ name: <IM displayName, trimmed,
  else "Anonymous guest">, role: "guest", anonymous: true }` **(designer's call)**. The IM name is
  what every chat member already sees, and several anonymous people in one group thread stay
  distinguishable. `postUserMessage` gets an optional `senderName` for this path only.
- **API**: service tokens cannot post messages (`requireUser`); a personal token posts as its
  person, so `sender` is that person.
- **Wake runs** (finished background task, sub-agent delivery) have no new user message: the run
  still writes its `run_context` changes; no sender anywhere.
- **Scheduled runs** do not exist today. Rule for when they arrive: a run triggered by no person
  never borrows a person's name (not the owner's, not the last sender's); its trigger message has
  no `sender` or a sender shape that design adds. The `run_context` rules apply unchanged.

## 8. Replay, evals, multi-replica

- **Replay**: both inputs are in the log (`run_context` events, `user_message.sender`), so step
  replay renders them as recorded. **No `DriftReason`**: the skill requires one when an old log
  lacks a record of something the model saw; an old log has neither, and its model saw neither, so
  it rebuilds byte for byte (the same reasoning as `tools_changed` and `subagent_delivery`).
  Request building reads no clock, PG or config for these.
- **Full-run replay** copies the run's `run_context` (if any) unchanged into the eval
  conversation, as it copies `skills_catalog`; the replay run never records a new one, so a
  candidate sees the original date, names and org, not the eval day's **(designer's call)**. A
  candidate agent version with another name still sees the recorded name (the case is about what
  the original saw). Seeded `user_message`s keep their `sender`.
- **Zero-drift tests** (`reconstruct.test.ts`, `rename-compat.test.ts`) run before and after the
  change; the frozen fixtures (`pre-rename/`, `pre-background-subagents/`) must stay untouched and
  at zero drift.
- **Multi-replica**: `run_context` is written in the run start's own transaction under the
  conversation row lock, idem key `run_context:<runId>` (one per run at most; a retried run start
  finds it, or finds nothing changed by the fold). `sender` is written in the message's
  transaction. No process state, no timers; `notify` after commit.

## 9. Web and API

- The conversation timeline ignores `run_context` (added to `lib/conversations.ts` as a typed,
  not-rendered event, like `tools_changed`). `sender` is not shown: the page keeps naming authors
  from the live account **(designer's call)**; showing names per message in shared conversations
  is a separate UI question (§11 Q4).
- The trajectory viewer shows `run_context` as a system row with its rendered text, like
  `reminder`, because graders must see what the model saw **(designer's call)**.
- The events API returns both to conversation participants: they already see the agent, the org
  and each other's names.
- Org settings page: the time zone select (§3.3).

## 10. Cost and tests

**Token cost** (rough, English text): first snapshot about 90 tokens plus up to 50 for the
description; sub-agent snapshot about 35; an update 15 to 30 per changed field; a sender line
about 6 per user message. A conversation used daily for a month: about 90 + 30 × 15 ≈ 550 tokens
of snapshots plus 6 per message. The skills catalog is far larger.

**Tests**:

- Unit (`run-context.test.ts`): fold, change detection per field, the date rule (later only, tz
  change), text rendering (first, update with "it was", sub-agent, anonymous sender, no role),
  name sanitising.
- `build.test.ts`: first snapshot at its position after the first message; an update appended at
  the end; the system text identical with and without snapshots; the sender block before
  `content[0]` and the fork report still last; a summary covering snapshots restores the current
  context after the summary, uncovered updates render after it; old logs (no event, no field)
  render exactly as before.
- `reconstruct.test.ts`: a new zero-drift case from real runs (first run, an agent rename between
  runs, a day change via an injected clock, two senders, compaction covering a snapshot, a
  sub-agent child case); requests equal the provider capture (`provider-capture.ts`).
- Run worker: snapshot written once per run at run start; no write when nothing changed; a wake
  run writes the date change; a retried run start writes nothing twice; dual-replica: two replicas
  racing the same run start append one event.
- Messages: `sender` from display name and role at send time; a rename afterwards leaves the
  logged message unchanged; IM bound and anonymous (fake channel); a dispatch message has none.
- Full-run replay: the recorded `run_context` copied, no new one written.
- Org settings: `timeZone` PATCH validation, lenient read.
- Live (acceptance): "你叫什么名字？" and "我是谁？" answered from the snapshot and the sender line;
  rename the agent, send again, the answer follows.

## 11. Open questions for the maintainer

1. **Description source**: the snapshot uses the agent profile description (unversioned, ≤ 500
   chars, cut to 200 in the snapshot). Fine, or should it come from the versioned definition?
2. **Time zone and language**: one per org (new `timeZone` setting, the existing `locale`), or per
   person (the web sends the browser's time zone and UI language with each message, recorded on
   `user_message` beside `sender`)? Per org is simpler and IM has no browser; per person suits
   orgs spread across zones.
3. **Sender line on every message**, or only when the sender differs from the previous user
   message in the request (fewer tokens, but the rule depends on the summary boundary)? Drafted:
   every message.
4. **Show `sender` in the web** (names per message in shared or IM-bridged conversations), as a
   later UI change?
5. **Anonymous IM guests**: use their IM profile name (drafted), or always "Anonymous guest"?
