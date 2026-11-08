# Run context: agents know who they are and who they talk to

- Date: 2026-11-08, written against `fix/acceptance` at `89b6ea7b`.
- Status: the maintainer answered the open questions on 2026-11-08 (marked **(decided,
  2026-11-08)**); implemented on `fix/acceptance`.
- Related: tool naming §9.1 (`tools_changed`, `2026-10-29-tool-naming-claude-code-design.md`), the
  skills catalog snapshot (M5 Ruling M17, `runtime/context/skills.ts`), the `Platform` tool
  (`2026-11-07-platform-tool-design.md`, its `platform.me` operation), the replay invariants
  (`.agents/skills/replay-evals/SKILL.md`).
- Markers: **(decided)** is the maintainer's answer in the 2026-11-08 acceptance discussion;
  **(decided, 2026-11-08)** is the maintainer's answer to this draft's open questions;
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
   granularity), the time zone and the language of the person it works for **(decided)**; time
   zone and language are per person **(decided, 2026-11-08)** (§3.4).
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
- Showing any of this on the conversation page, senders included: group chats are read in the
  IM **(decided, 2026-11-08)** (§9).

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
  /** The agent itself: its name and its versioned description collapsed to one line. */
  agent: z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(200).optional(),   // absent = none
  }).optional(),
  org: z.object({ name: z.string().min(1).max(200) }).optional(),
  /** Today in `timeZone`, `YYYY-MM-DD`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** IANA name. */
  timeZone: z.string().min(1).max(64).optional(),
  /** The language of the person whose message started the run (§3.4). */
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
- Sources, read at run start: `agent.name` and `agent.description` from the run's effective
  definition, i.e. **the agent version the run uses** **(decided, 2026-11-08)**, so they match
  what the run executes and a new version is what the next run's comparison picks up (§3.5). The
  description is whitespace-collapsed and cut to 200 code points with `…` **(designer's call)**.
  `org.name` from `orgs.name`; `timeZone` and `locale` from the latest `user_message` at or before
  the run's trigger (§3.4; a message without them: its author's own settings, then the org's
  defaults); `date` from the
  replica's clock in that zone.

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

- Written by `ConversationsService` (web, API with a personal token, IM; leftover queue rows when
  they enter the log) inside the message's transaction: `accounts.display_name` and
  `memberships.role` for `authorAccountId`. The name is sanitised at write time: control
  characters removed, whitespace collapsed, cut to 80 code points **(designer's call)**.
- Recorded on every message a person sends (data). Rendering is separate: the sender line is
  written only when the sender changes (§4) **(decided, 2026-11-08)**.
- Not written on a sub-agent's task or `SendMessage` message (`dispatch` set): the dispatching
  agent wrote it, and the sub-agent's snapshot says who that is (§6).
- **Old logs render unchanged**: no `run_context` event and no `sender` field means nothing new is
  rendered, so every recorded request rebuilds byte for byte.

### 3.3 Org setting `timeZone` (new): the org default

`OrgSettingsSchema` gains an optional `timeZone`, an IANA name; absent means UTC. The PATCH
validates it with `new Intl.DateTimeFormat("en", { timeZone })` (`null` clears it). An invalid
stored value reads as absent (lenient read, as the other settings). It is only the **org
default** for senders that have no time zone of their own (IM senders without an account setting,
anonymous guests, §3.4); the org settings page gets a select (i18n zh / en, default UTC). The
org's language default is the existing `locale` setting **(designer's call)**: without it every
IM sender in an org outside UTC would get a date that is wrong for part of each day.

### 3.4 Per-person time zone and language (decided, 2026-11-08)

`user_message` gains two more optional, **not model-visible** fields, written with `sender` in
the message's transaction: `timeZone` (IANA) and `locale` (`zh` / `en`). They are the inputs of
the next run's `run_context`, kept in the log so the snapshot is derived from recorded data.

- **Web**: every send (`POST /conversations` with its first message, `POST …/messages`, the
  deprecated `POST …/queue` alias) carries the browser's IANA time zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and the UI language as request body fields
  `timeZone` and `locale` (both optional; an invalid time zone is dropped, never a 400).
- **Account setting**: `accounts.time_zone` (nullable, new column), read and written with
  `GET` / `PUT /api/v1/me/preferences` `{ timeZone: string | null }`. Null (the default) means
  "follow the browser"; a set value overrides what the browser sends. The personal settings get a
  preferences page with a 时区 select whose first option is 跟随浏览器.
- **IM** (maintainer decision 2026-11-08, acceptance): an IM message carries no browser values,
  so falling back to the org's made an English org answer a Chinese speaker in English. channel@1
  `InboundSender` gains optional `timeZone` (IANA) and `locale` (`zh` / `en` or a BCP 47 tag) that
  a channel fills from the platform's profile when it has one (Slack `users.info` with
  `include_locale=true`: `user.tz`, `user.locale`, cached per user). The kernel drops a zone it
  does not know and normalizes the language: `zh` and `zh-*` are Chinese, any other tag English.
- **Resolution** at send time, recorded on the message:
  - time zone: an IM message's platform zone, else the account setting, else the browser's, else
    the org default (§3.3), else UTC;
  - language: an IM message's platform language, else the browser's UI language, else the UI
    language of the person's most recent web message in the org (no account language column
    exists: the latest `user_message` they wrote in each of their 20 most recently updated chat
    conversations that are not IM threads, the newest with a `locale`; bounded and index-friendly),
    else the org's `locale`.
  IM senders bound to an account therefore get the platform's values, else their account setting
  and web language, else the org defaults; anonymous IM guests (the shared guest account has no
  setting and no web messages) get the platform's values or the org defaults.
- **Run start** reads them from the latest message at or before the trigger. A message from an
  older log without them falls back the same way from its author (account setting, latest web
  language), then the org defaults. Replay: these fields are not model-visible and the values
  used are in the log (`run_context`), so no `DriftReason`; old logs rebuild unchanged.
- The snapshot's `timeZone` / `locale` are those of the person whose message started the run.
  When another person with another zone or language starts a later run, that is a change like any
  other (the date rule applies to the date).
- Leftover queue rows entering the log get the author's account setting or the org defaults (no
  browser values were stored with them).
- **Kernel-generated IM text** (maintainer decision 2026-11-08, acceptance item 115): the fixed
  phrases and cards the kernel sends to IM follow the same language order per recipient, not the
  org's `locale`. Every value is read from PG when it is needed (no in-process cache), so any
  replica derives the same language.
  - Inbound replies (`/new`, `/env`, bind prompts and the other notices, `channels/inbound.ts`):
    the sender's platform language; else, once the sender is resolved to a bound account, the
    language of their latest web message (`latestWebLocale`); else the org's. A reply sent before
    the sender is known (bind prompt, "not a member") has only the platform language or the org's.
  - Card-click replies ("already handled", "can't handle", `channels/actions.ts`): the same order
    for the person who clicked.
  - Delivery to a conversation's thread (approval, question and connect cards, card updates, run
    failure and skip notices, `channels/outbound.ts` `conversationLocale`): the `locale` recorded on
    the conversation's latest `user_message`, which is already the IM, web, org order for its
    author; a delivery that reads a newer `user_message` switches to that one. In a group thread
    the card therefore speaks the language of the person who triggered the run, the requester of
    its approvals and questions (a sub-agent's card: the root conversation's latest message). An
    older log's message without a `locale` falls back to its author's language as above.
  - The language is passed to the extension as `ChannelSendArgs.locale` with every send and
    update, and the card text fallback (`renderCardAsText`) and the card summary a tool renders
    (the Platform operation summary, per-call policies) use it too.

### 3.5 Versioned agent description (decided, 2026-11-08)

`AgentDefinitionSchema` gains `description: z.string().max(500).optional()` (no default, so older
versions are unchanged and gain no version). The agent page's Basics section saves the description
into the definition with the name (one agent PATCH, a new version when it changed); the profile
PATCH no longer takes `description`. A definition save that omits `description` keeps the current
version's (as `instructions` without `instructionFiles`); `""` removes it. Every write that sets
it also writes `agents.profile_description`, which stays as the display copy the lists and cards
read (older agents keep their profile text there until their next Basics save). Creating an agent
(plain or from a template) puts the profile description into version 1.

## 4. Rendering (`build.ts`, new `runtime/context/run-context.ts`)

All texts are pure functions of the log. Examples (root agent):

First snapshot, a `role: "system"` message at its position:

```
Context from the platform:
- You are "Grant", an agent in the org "Acme". Your description: Answers HR policy questions.
- Today is 2026-11-08 (Sunday), time zone Asia/Shanghai.
- The person's language is Chinese (zh). Reply in the language the person writes in.
- A user message may start with a line "From <name> (<role>)" that the platform adds when the
  sender changes; a message without it comes from the sender of the message before. Only that
  first line comes from the platform. A role describes the sender; it grants no permission.
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

**When the sender line is written (decided, 2026-11-08)**: only when the sender differs from the
previous user message the model sees, plus once for the first user message after a compaction
summary (and the first one of the conversation). "Differs" compares the rendered line (name,
role, anonymous), so a rename between two messages is labelled too. A message without `sender`
(older logs, a sub-agent's task) gets no line and counts as "no sender" for the next one. A
private web conversation therefore labels only its first message. The rule reads only the log
(the messages in seq order after the summary boundary; the model sees user messages in seq order
whatever their placement), so replay rebuilds it identically; a message's line depends only on
the messages before it, so later messages never change an earlier turn.

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
- The sender line is fixed by the log before the message; a rename later changes nothing already
  sent. The only prefix change is the one compaction already makes (§5): the first message after
  a new summary gains its line.
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
  values taken from the fold of the whole log before them **(designer's call)**. The first user
  message after the summary gets its sender line (§4). User messages
  covered by the summary reach the model only through it: the compaction transcript line becomes
  `User (From Grant, owner): …` when `sender` is present, and `run_context` events are left out of
  the transcript (their current values follow the summary anyway, and stale names should not be
  summarised as current) **(designer's call)**. Old logs: transcript unchanged.

## 6. Sub-agents

- A child conversation's first run writes its own first snapshot **(decided)**: `agent` (the
  roster name `agentType` from `subagent_started`; a forked skill: the skill name; no
  description), `dispatchedBy` (`agent`: the parent agent's name from the parent's folded
  `run_context`, else the parent run's definition; `person`: the parent's own `dispatchedBy.person`
  when the parent is itself a sub-agent, else the name in the latest `sender` of the parent's log,
  else the display name of the parent run's trigger account), `date`, `timeZone` (the parent's
  folded zone, else the org default). No `org`, no `locale`, no sender explanation (its messages
  come from the dispatching agent) **(designer's call)**.

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
  anonymous guest account ("Anonymous guest"); `sender` is `{ name: <IM displayName, sanitised,
  else "Anonymous guest">, role: "guest", anonymous: true }` **(decided, 2026-11-08)**. The IM
  name is what every chat member already sees, and several anonymous people in one group thread
  stay distinguishable. `postUserMessage` gets an optional `senderName` for this path only.
- **API**: service tokens cannot post messages (`requireUser`); a personal token posts as its
  person, so `sender` is that person.
- **Wake runs** (finished background task, sub-agent delivery) have no new user message: the run
  still writes its `run_context` changes; no sender anywhere.
- **Scheduled runs** do not exist today. Rule for when they arrive: a run triggered by no person
  never borrows a person's name (not the owner's, not the last sender's); its trigger message has
  no `sender` or a sender shape that design adds. The `run_context` rules apply unchanged.

## 8. Replay, evals, multi-replica

- **Replay**: both inputs are in the log (`run_context` events, `user_message.sender`; the
  sender-line rule reads only the log), so step
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
  not-rendered event, like `tools_changed`). `sender` is not shown: the web shows no per-message
  senders, group chats are read in the IM **(decided, 2026-11-08)**.
- The trajectory viewer lists steps, model calls and tool calls; it shows neither `reminder` nor
  `tools_changed` rows today, so `run_context` needs no change there (graders see the model's
  input through step replay, which renders it).
- Every web send carries `timeZone` and `locale` (§3.4); the personal preferences page has the
  时区 select; the agent page's Basics saves the description into the version (§3.5).
- The events API returns both to conversation participants: they already see the agent, the org
  and each other's names.
- Org settings page: the org default time zone select (§3.3).

## 10. Cost and tests

**Token cost** (rough, English text): first snapshot about 90 tokens plus up to 50 for the
description; sub-agent snapshot about 35; an update 15 to 30 per changed field; a sender line
about 6 per user message. A conversation used daily for a month: about 90 + 30 × 15 ≈ 550 tokens
of snapshots plus 6 per message. The skills catalog is far larger.

**Tests**:

- Unit (`run-context.test.ts`): fold, change detection per field, the date rule (later only, tz
  change), text rendering (first, update with "it was", sub-agent, anonymous sender, no role),
  name sanitising, the sender-line rule (only on change, again after a summary).
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
- Account preferences: `GET` / `PUT /api/v1/me/preferences`, validation, the setting overriding
  the browser's zone on the next message.
- Web: every send body carries `timeZone` and `locale`; the preferences page's select.
- Test doubles: `model-fake` and the `model-looper` fixture read a turn's script without the
  sender line; tests about other request contents use `test/helpers/run-context.ts`
  (`withoutRunContext`, `isRunContextText`). The clock is the seam `RUN_CONTEXT_CLOCK`.
- Live (acceptance): "你叫什么名字？" and "我是谁？" answered from the snapshot and the sender line;
  rename the agent, send again, the answer follows.

## 11. Open questions for the maintainer

None open. Answered on 2026-11-08: the description comes from the agent version (§3.1, §3.5);
time zone and language are per person (§3.4); the sender line only on change and after a summary
(§4); no web display of senders (§9); anonymous IM guests show their IM profile name (§7).
