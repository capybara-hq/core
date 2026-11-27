# Idle compaction

Status: design, for maintainer review (2026-11-27). Issue #955. Builds on the context compaction
design (`2026-11-14-context-compaction-design.md`, cited as "compaction spec §n"), whose §2 and §6
listed background precomputation as a non-goal / deferred item; this spec takes it up in a form
that keeps compaction synchronous and in the event log.

## 1. Why

A long chat conversation often crosses the compaction line during its last step: the final
assistant reply and tool results land after the step-boundary check (compaction spec §4.1), so the
conversation is over the line when the run ends. The person's next message then waits for the
summary request (tens of seconds; longer when it is chunked, §4.5) before the agent starts
answering. The person was away anyway; the wait could have happened while they were gone.

Claude Code (2.1.332) does this: it arms a timer at every turn end and, when the session has been
idle for most of the prompt cache's lifetime, compacts in the background. Its motive is twofold:

1. **Latency.** The returning person does not wait for a compaction.
2. **Cache cost.** Its summary request reuses the conversation's cached prefix, so summarizing just
   before the cache expires is cheap, and the returning person avoids a full-price re-read of a
   large context followed by an immediate compaction. It therefore fires at 90% of the cache
   lifetime and only with the 1-hour cache, not the 5-minute one.

What Claude Code does, for reference (reverse-engineered; not a contract):

- Guards when the timer fires: auto-compaction or the `idleCompaction` setting off (default on);
  the cache lapsed or the timer more than 60 s late (the machine slept); context under 200k tokens
  (env override, floor 100k) or grown under 100k since the last compaction; a newer request since
  arming; close to a rate limit; the prefix changed (a model switch). Interactive refusals: the
  session is held by another process, the transcript advanced elsewhere, a turn is running or
  waiting on the user, the user interacted within 60 s.
- Two execution modes: (a) compact directly under the turn guard and discard the result if a newer
  turn started (a generation check; notice "Compacted while idle, before the prompt cache
  expired"); (b) headless / SDK: precompute the summary with the saved cache-safe parameters, hold
  it, and swap it in at the next turn's compaction check ("Compacted using a summary written while
  you were away").
- Telemetry on each fire's outcome and on "return after idle" (over 30 min idle, over 100k
  context) to measure the value.

**Capybara today gets only the latency benefit.** Our summary request transcribes events into text
and may be chunked (compaction spec §4.5); it shares no prefix with the conversation's requests, so
it hits no provider's prompt cache, whatever the provider caches. Cache behavior is also per
provider and per model, so Claude Code's "90% of a 1-hour cache" cannot be hard-coded in the
kernel. Hence two phases (maintainer direction, 2026-11-27):

- **Phase 1 (build first):** a fixed idle delay, set by the platform and overridable per org.
  Latency benefit only.
- **Phase 2 (designed here, built later):** model providers declare per-model cache behavior and
  report the cache lifetime a call actually used; the summary request learns to reuse the
  conversation's cached prefix; where both hold, idle compaction fires shortly before the cache
  expires, otherwise it keeps the fixed delay (§9).

## 2. Goals and non-goals

Goals:

1. A person returning to a long idle chat conversation does not wait for a compaction the kernel
   could have done while they were away.
2. Bounded cost: idle compaction runs only on conversations large enough for it to matter, at most
   once per finished run, never on conversations nobody started by hand.
3. Multi-replica safe, in the event log, replayable, with no new model-visible input.
4. Platform default, org override, personal opt-out.
5. Phase 2 has a clear, provider-neutral contract that does not change phase 1's shape.

Non-goals:

- **Precompute and swap** (Claude Code's mode b). See §5.6: the event log makes it unnecessary.
- **A new compaction algorithm.** Idle compaction is the existing compaction (plan, summary
  template, chunked fallback, fit guard) started at another moment.
- **Compaction of sub-agent and eval conversations.** They take no compaction today (compaction
  spec §4.7; `ForceCompactionInput.conversationKind: "chat"`), and they gain none.
- **Phase 2's cache timing and cache-reusing summary in phase 1.**
- **Presence or typing signals.** The kernel has no "person is reading / typing" signal; a new
  message preempts an idle compaction instead (§5.5).

Anti-goals: an idle compaction that delays a person's message more than an inline one would; a
summary held outside the event log; a second timer mechanism beside BullMQ.

## 3. Chosen approach

**Idle compaction = an automatic compact run**, started by a delayed job owed at run finish.

```
run finishes (chat, eligible trigger + outcome)
  └─ same transaction: outbox row idle-compact-<runId>, runAt = finish + delay
       └─ job fires (worker, runJob, org scope)
            ├─ obsolete / guards fail ─▶ log the outcome, done (no event written)
            └─ eligible ─▶ start an idle compact run (conversation row lock, re-check)
                 └─ run worker: the manual compact path (CompactionService.force)
                      ├─ compaction_summary + usage ─▶ run_finished
                      └─ a person's message arrives ─▶ aborted (superseded); the message's run follows
```

It reuses everything manual compaction (compaction spec §4.7) already has: the `runs.compact` run
path in the run worker, mutual exclusion with ordinary runs through the run claim, progress (§4.6),
the summary's usage and hooks, abort without a partial summary. What it adds is the job that decides
*whether* and *when*, the checks the manual path skips (enabled, size, backoff), and preemption.

Rejected:

- **B. Compute the summary inside the job, outside a run.** It would write `compaction_summary`
  without the run claim, racing a step that compacts or appends at the same time; the summary's
  coverage (`coversUpToSeq`) could then fall behind or interleave with a running step. The run
  claim already solves this.
- **C. A periodic sweep over idle conversations** (`@LockedInterval` scanning for conversations
  idle for N minutes). Works without arming, but scans every org's conversations each tick, needs
  an index on "last activity", and fires late by up to a tick. One delayed job per finished run is
  cheaper and exact.
- **D. Precompute and swap** (§5.6).

## 4. Trigger and guards

### 4.1 Arming

A run arms idle compaction when, in its finish transaction (`RunFinish.finishIn`):

- the conversation is `kind = 'chat'` (not sub-agent, not eval);
- the run's `run_started.trigger` is `message` (a person's message), `background_task` or
  `subagent` (wakes continuing a conversation a person started); **not** `schedule` (a scheduled
  task's conversation is often never read again: compacting it is cost without a reader) and not
  `compact` (manual or idle);
- the outcome is `completed`, `max_steps`, `max_duration` or `max_output`; **not** `budget` (the
  run stopped to save money; do not spend more), `failed`, `aborted` (the person stopped it, or the
  org is going), nor a suspended run (not terminal: waiting on a person);
- the effective settings have `enabled` and `idleEnabled` true (read in the transaction; a later
  change is re-read when the job fires).

Arming is one outbox row (`OutboxService.add`, writing-kernel-api "Owed work"):

- queue `cap-kernel-maintenance` (one consumer, `MaintenanceProcessor`, dispatches by name; no new
  queue) or a dedicated `cap-idle-compaction` queue if the builder finds the maintenance queue's
  concurrency unsuitable (§11, Q6);
- name `idle-compaction`, job id `idle-compact-<runId>` (no `:`; one per finished run, so owing it
  twice is a no-op);
- data `{ orgId, conversationId, runId, armedSeq }`, where `armedSeq` is the conversation's highest
  event seq written by the finish transaction (the `run_finished` event);
- `runAt = now + idleDelayMinutes`; `orgId` set, so an org's deletion removes the pending row.

Why the outbox and not an `afterCommit` hint (prompt suggestions enqueue as a hint): losing one
idle compaction is harmless, but this is *delayed* work, and the outbox's relay is already the
only sanctioned way to give BullMQ a future job (`kc-enqueue-via-outbox`); a hint would need a new
`KC_EXCEPTIONS` entry and still a delayed `add`. The row is small and deleted on delivery.

Registry entry (`OUTBOX_JOBS`): `idempotent`: "the job re-reads the conversation and starts at most
one idle compact run under the conversation row lock, only while the conversation's latest seq is
still `armedSeq`; a duplicate delivery finds the seq advanced (by the first delivery's run) or an
active compact run and does nothing"; `opts`: `attempts: 3`, short backoff, `removeOnComplete:
true`.

### 4.2 Re-arm and cancel

There is no cancellation. Every finished run owes its own job; an earlier job that fires after a
later run finds the conversation's latest seq above its `armedSeq` and ends as `obsolete`. Any
event appended after the arming run (a new message, a queued message, a model switch, a permission
profile change, an earlier idle compaction's own run) makes the job obsolete: the conversation was
touched, and the later run (if any) arms its own job. A job per finished run is cheap (one indexed
read when it fires); cancelling BullMQ delayed jobs from the run path would add a Redis call to a
hot transaction path for no gain.

### 4.3 Guards when the job fires

The job runs inside `runJob` (org scope from `orgId`), on the worker role, and checks in this order;
the first failing check ends it with that outcome (§7) and writes no event:

| # | Check | Outcome |
|---|---|---|
| 1 | org live; conversation live, `kind = 'chat'`; agent not deleted | `gone` |
| 2 | latest event seq of the conversation `== armedSeq` | `obsolete` |
| 3 | no active run (queued, running, suspended); no unconsumed message; queue head empty | `busy` |
| 4 | effective `enabled` and `idleEnabled` (live, platform + org); conversation owner's preference not off (§6.3) | `disabled` |
| 5 | the job is not stale: `now - finishedAt <= idleDelay + IDLE_MAX_LATENESS` (6 h) | `stale` |
| 6 | the latest compaction record after the latest summary is not a `compaction_failed` (respect the failure backoff: an idle retry of a failing compaction is cost without progress) | `backoff` |
| 7 | the effective definition's model is enabled for the org and resolvable | `no_model` |
| 8 | size: the calibrated estimate of the next step's request `>= min(idleMinTokens, triggerLine)` | `small` |
| 9 | growth: the part the plan would summarize (not yet covered by a summary) is `>= IDLE_MIN_GROWTH_TOKENS` (20k, or a quarter of `idleMinTokens`, whichever is smaller) and the compaction plan is non-empty | `small` |

Then it starts the run (§5.1); a refusal there (a message arrived in between) is `obsolete` / `busy`.

Notes on the guards:

- **Staleness (5)** replaces Claude Code's "timer late by more than 60 s / cache lapsed". Phase 1
  has no cache to lapse, so lateness costs nothing except when the worker was down for hours and
  a backlog of jobs would compact many conversations at once on restart; 6 h bounds that. Phase 2
  re-adds a cache-lapse check for the cache-timed mode (§9.5).
- **Size (8).** `triggerLine = min(threshold * W, W - O_p - R_p)` from compaction spec §4.1 (the
  same `planningBounds`; `shouldCompact` without the hard-line shortcut). A conversation over the
  trigger line would compact on the next step anyway: idle compaction only moves that cost earlier
  (and spends it even if the person never returns, §8.2). Below the line, `idleMinTokens` (default
  100k, like Claude Code's floor) picks conversations whose next request is large enough that a
  smaller context matters. The estimate is built as `CompactionService.force` builds it: the
  effective definition (the next run's agent version and model selection, including
  `model_switched`), its tools, the calibrated estimator.
- **Growth (9)** stops a conversation that was just compacted (summary + a short tail) from being
  compacted again for a few tokens.
- **No rate-limit guard.** The kernel has no provider rate-limit signal; a provider error fails the
  compaction like any other (`compaction_failed`, which then blocks later idle attempts through
  guard 6 until a summary succeeds).

The guards 1–9 are a pure function over the conversation facts, the settings and the estimate
(`idleCompactionDecision(...)`), unit-tested on its own; reading the facts and the estimate is the
job's.

## 5. Job and run lifecycle

### 5.1 Starting the idle compact run

`RunQueue.startIdleCompaction(conversationId, armedSeq)`, a sibling of `startCompaction`
(`runtime/run-queue.ts`), in one `@Transactional({ propagation: "requires_new" })` method under the
conversation row lock (the lock `ensureRun` takes):

- re-check guards 1–3 under the lock (latest seq still `armedSeq`, no active run, no unconsumed
  message); a refusal returns null, never throws (the job is not an API call);
- insert the run row as `startCompaction` does (`compact: true`, `trigger_seq = consumed_seq`, the
  deterministic run job id via `jobIdFor`, owed through the outbox), with `compact_origin = 'idle'`
  (a new column, §5.7) and `trigger_account_id` = the conversation's owner (`conversations.account_id`):
  usage, hooks and audit attribute the calls to the person whose conversation it is;
- the run worker takes the compact path unchanged (`CompactionService.force`, `step: 0`, `force:
  true` because the job already decided; the plan is still required, so an empty plan writes
  nothing and the run finishes `completed` with no summary).

`run_started` carries `trigger: "compact"` (unchanged, so every reader that skips compact runs:
channels' progress, prompt suggestions, eval planning, keeps working) plus a new optional
`compactOrigin: "idle"` (absent = manual), display only (§6.4, §8).

### 5.2 Race with a new message: preemption

Idle compaction must never make the person wait longer than an inline compaction would. Today a
message that arrives during an active run waits for the run to end (`ensureRunIn`: "an active run
takes what arrives at its next step or is followed by the next run after its end"); a compact run
has no next step, so the message would wait for the whole summary.

Rule: **a person's message (any `ensureRun` that finds unconsumed input) preempts an idle compact
run.**

- In `ensureRunIn`, when the active run is a compact run with `compact_origin = 'idle'` and there is
  unconsumed input, request its abort through the existing abort channel (`RunAbort`, the
  cross-replica watch the worker already holds) with a new `run_aborted.reason: "superseded"` and
  no account; then return null as for any active run. The run worker's existing abort branch
  writes `run_aborted`, no partial summary; the run's finish then calls `ensureRun`, which starts
  the message's run. A queued, not yet claimed idle run is finished as aborted directly in the same
  transaction (nothing to stop).
- The message's run compacts inline if it needs to (it would have anyway). The summary calls
  already made are billed and recorded (`usage`, compaction spec §4.5): the waste is bounded to one
  partly done compaction, only when the person returns during the minute or so it runs.
- If the abort arrives after the `compaction_summary` was written (the `writing` phase), the summary
  stands: it is a valid summary in the log, the run ends aborted, and the next step uses it.
- A **manual** compact request while an idle compact run is active returns the idle run's id (the
  existing "a compact run already queued or running: the same request again"); the person then
  watches it finish. A manual compact run is never preempted.
- Background wakes (`background_task`, sub-agent deliveries) are input like a message: they
  preempt too. A scheduled task's message into a chat conversation also preempts.

Alternative considered: let an idle run finish when the conversation is over the trigger line (the
message's step would compact anyway). Saves the wasted call in that case but makes the person wait
on a summary whose progress they may not see (a channel conversation shows none); rejected for
simplicity and the anti-goal. Open question Q3.

### 5.3 Fire timing

Phase 1: `runAt = finishedAt + idleDelayMinutes` (default 10 min, §6.1). The delay is measured
from the run's end, not from the last message seen: the person's attention starts when the reply
arrives.

Why 10 minutes: long enough that a person still reading the reply or typing the next message is
rarely preempted; short enough that most "back after a coffee / meeting" returns find the summary
ready. Without a cache benefit, a later fire only loses returns (more people come back before it).
Claude Code's ~54 minutes follows from its cache lifetime, which phase 1 does not have.

### 5.4 Abort, shutdown, failure

- Shutdown or a lost lease during an idle compact run: as for a manual one (`interrupted`, the job
  goes back to another replica, which re-runs the compaction; the summary's idempotency keys are
  the run id and ordinal, compaction spec §4.4).
- A failed compaction writes `compaction_failed` and the run finishes `completed`, exactly as a
  manual one; guard 6 blocks idle attempts until a summary succeeds (the next step's own trigger
  follows its own backoff).
- Org deletion: the outbox row goes with the org; a run already started is aborted by the existing
  org-deletion path (`org_deleted`).

### 5.5 Why no "person interacted within 60 s" guard

Claude Code refuses when the user interacted within 60 s because its compaction shares the
process with the person's input. In Capybara the guard is structural: any input appends an event
(the job is then obsolete) or arrives during the run (it preempts it). Reading the page without
typing is not observable and does not need to be: compaction does not change what the page shows
besides the divider.

### 5.6 Precompute and swap (Claude Code mode b): not needed

Claude Code's headless mode computes the summary off the turn path, holds it, and swaps it in at
the next turn's compaction check, because its compaction otherwise runs inside the session's
turn guard and would block or race the next turn.

In Capybara:

- `compaction_summary` is an appended event; the next step reads it from the log like any summary.
  Swapping in later would mean holding a summary **outside** the log (in Redis or a side table)
  and appending it at the next step: a second source of truth, a coverage check at swap time
  (`coversUpToSeq` and `openingSeqs` against what happened since), and a replay question (the
  event would be written by a run that did not compute it).
- The compact run's claim already gives what mode (b) buys: the summary is computed without
  blocking anything (no ordinary run is active), and the next run starts after it or preempts it.
- Mode (b)'s one advantage, not discarding a nearly finished summary when the person returns, is
  small (§5.2) and does not justify a held summary.

Decision: no precompute; the idle compact run writes the summary directly.

### 5.7 Data changes

- Migration `NNNN_idle_compaction.sql`: `ALTER TABLE runs ADD COLUMN IF NOT EXISTS compact_origin
  text NULL` with a check (`'manual' | 'idle'`, null for ordinary runs; existing compact runs read
  as manual). `runs` has no `org_id` of its own (org via the conversation), so no RLS change; the
  builder confirms against `check:org-filter`.
- Events (`conversations/events.ts`): `run_started.compactOrigin?: "manual" | "idle"`;
  `run_aborted.reason` gains `"superseded"`. Additive; old logs parse.
- No change to `compaction_summary`, `compaction_failed` or `usage`.

## 6. Settings and UI

### 6.1 Platform and org

Three fields join `COMPACTION_FIELDS` (`identity/settings.ts`), flat so the existing field-by-field
`effectiveCompactionSettings` merge, the org "follow platform" state and the `null`-clears patch
semantics carry over unchanged:

| Field | Default | Range | Meaning |
|---|---|---|---|
| `idleEnabled` | `true` (Q1) | boolean | compact idle conversations in the background |
| `idleDelayMinutes` | 10 | 1–1440 | idle time after a run ends before the background compaction |
| `idleMinTokens` | 100000 | 10000–2000000 | smallest next-request estimate worth compacting below the trigger line |

`enabled: false` (automatic compaction off) also turns idle compaction off: it is automatic
compaction. Manual compaction stays available whatever these say.

Phase 2 adds one platform/org field, `idleTiming: "fixed" | "cache"` (default `cache`), §9.5.

### 6.2 Platform tool parity

No new route. The fields join existing shared schemas (`COMPACTION_SETTINGS`,
`COMPACTION_SETTINGS_PATCH`, `DEPLOYMENT_SETTINGS_PATCH.compaction`, the org settings patch), which
the existing Platform operations (`admin.settings` / `admin.update-settings`, `org-settings.get` /
`org-settings.update`) are built from; `platform-parity.test.ts` covers them through the shared
schema. Same for the personal preference (§6.3), which joins `PreferencesSchema` behind the
existing `GET` / `PUT /api/v1/me/preferences` operations. `pnpm check:platform-ops` must stay green;
no exclusion is added.

### 6.3 Personal opt-out

`PreferencesSchema` gains `idleCompaction: "off" | null` (null = follow the org). Checked at guard
4 against the conversation's owner. A person who wants every detail kept verbatim until they come
back, or who does not want background model calls in their name, turns it off in their account
preferences ("Account" page, a switch in the existing preferences form). It is a narrowing only:
a person cannot turn idle compaction on where the org has it off.

A per-conversation switch is not proposed (Q4).

### 6.4 UI

- **Settings pages.** The existing "Conversation compaction" section on the platform settings page
  and the org settings page (design components only, `check:web-ui`) gains the three fields; the
  delay and min-tokens fields are disabled while `idleEnabled` is off. zh / en:
  - `compaction.idleEnabled`: "空闲时在后台压缩" / "Compact idle conversations in the background";
    hint "对话停下一段时间后，在后台提前压缩，下次发消息时不必等待压缩。会在没人回来的对话上产生模型
    调用费用。" / "After a conversation has been idle for a while, compact it in the background so
    the next message does not wait for it. Spends model calls even on conversations nobody returns
    to."
  - `compaction.idleDelayMinutes`: "空闲多久后压缩（分钟）" / "Idle time before compacting
    (minutes)"; help "1–1,440，默认 10。"
  - `compaction.idleMinTokens`: "后台压缩的最小上下文" / "Smallest context to compact in the
    background"; help "下一次请求预计不少于这么多 token（或已到触发阈值）时才压缩（10,000–2,000,000，
    默认 100,000）。"
- **Account preferences.** "空闲时压缩我的对话" / "Compact my conversations while I'm away", with
  the org state shown when the org has it off ("组织已关闭").
- **Conversation page.** An idle compaction is quiet:
  - While it runs and the page is open, the existing compacting row (§4.6 of the compaction spec)
    shows, labelled "正在后台压缩会话…" / "Compacting in the background…".
  - When it is done, the existing divider reads "较早的会话已在空闲时压缩 · 节省 {n} tokens" /
    "Earlier conversation compacted while idle · saved {n} tokens" (the variant is chosen from the
    run's `run_started.compactOrigin`; the timeline already groups events by run).
  - A preempted idle run shows nothing (no "aborted" row): the compacting row disappears and the
    person's message proceeds.
  - The divider's menu (or a short help link) says where to turn it off: the account preference.
- **Channels.** Nothing: compact runs already send no progress, and the divider is a web element.
- Wording rules: zh says 智能体 / 平台, never 企业 or `agent` (`pnpm check:i18n`).

## 7. Observability

There is no metrics backend in the kernel; outcomes are structured log lines plus what the event
log already holds.

- **Job outcome**: one `info` log per job, `context=IdleCompaction`, `outcome` in `started | gone |
  obsolete | busy | disabled | stale | backoff | no_model | small`, with `orgId`, `conversationId`,
  `runId`, the estimate and the lateness.
- **Run outcome**: from the log: `compaction_summary` (with `savedTokens`) or `compaction_failed`,
  or `run_aborted.reason: "superseded"` (preempted), all in runs with `compactOrigin: "idle"`.
- **Return after idle** (the value measure): when a run starts on a conversation whose previous
  run ended more than 30 min earlier and whose next request estimate was over 100k at that end, log
  `idle_return` with the gap, whether an idle summary was written in between, and the step's
  inline compaction time if one ran (0 when the idle summary made it unnecessary). Together with
  usage (purpose `compaction`, joined to the run's origin) this answers "how often does the person
  come back, and what did idle compaction cost per avoided wait".
- **Admin**: the super admin's usage views may later split compaction usage by origin; not in
  phase 1 (Q5).

## 8. Usage, hooks, cost, replay

### 8.1 Usage and hooks

The summary calls are ordinary compaction calls: `model.request` fires per call with the existing
compaction fields (a policy hook may deny and fails closed: `compaction_failed`), `usage` events
with purpose `compaction`, `model_usage` rows, `usage.report` delivered through the outbox. The
trigger account is the conversation's owner. No hook payload change and no SDK change in phase 1.

### 8.2 Cost of conversations nobody returns to

An idle compaction on a conversation the person never returns to is pure cost: about one read of
the summarized history (at most the compaction model's window per chunk) plus up to
`maxOutputTokens` (20k) of output. Bounds:

- at most one idle compaction per finished run, and only after runs a person or their wakes
  started (§4.1); scheduled-task runs never arm;
- only above `min(idleMinTokens, triggerLine)` and with real growth since the last summary;
- never retried after a failure (guard 6); never after a `budget` stop;
- above the trigger line the cost was already owed by the next message; only conversations that
  are abandoned pay extra;
- the platform and each org can turn it off or raise `idleMinTokens`; a person can opt out.

The rollout (§10) measures the return rate before the default stays on.

### 8.3 Replay

- An idle compact run writes an ordinary `compaction_summary` (and `usage`); request building reads
  it as any summary. **No new model-visible input, no `DriftReason`.** `run_started.compactOrigin`
  and `run_aborted.reason: "superseded"` are display / run-control fields, not model-visible.
- Eval planning skips compact runs by `trigger: "compact"` (`evals/plan.ts`), so idle compact runs
  are skipped unchanged; a case snapshot that contains an idle summary rebuilds byte for byte.
- Zero-drift: add a `reconstruct.test.ts` case where an idle compact run's summary is followed by
  a message run, and one where an idle run was preempted (no summary, then a run that compacts
  inline); run the zero-drift fixtures before and after (replay-evals skill).
- Full-run replay does not reproduce idle compactions (it replays runs, not idle time); a candidate
  model compacts inline where it needs to, as today.

## 9. Phase 2: cache-aware idle compaction (designed now, built later)

### 9.1 What it is for

Two benefits phase 1 leaves on the table:

1. **A cheap summary.** If the summary request reuses the conversation's cached prefix, its input
   is billed at the cache-read price instead of full price.
2. **Timing against the cache.** If the kernel knows when the conversation's cache expires, it can
   compact just before, so the summary is cheap *and* the returning person's first request reads a
   small context instead of re-reading a large one at full price.

**A cache declaration alone buys nothing.** As long as the summary is a transcript (compaction spec
§4.5), it hits no cache, and firing "before expiry" saves nothing. 9.3 (the cache-reusing summary)
is the prerequisite for 9.4 (timing); 9.2 (declarations) is the prerequisite for both.

### 9.2 Provider declarations (model-provider@2, public SDK API)

Provider landscape (as understood at writing; to be re-verified per vendor when building):

- **Anthropic**: explicit caching (`cache_control` breakpoints); a 5-minute default lifetime,
  refreshed on each hit, and an optional 1-hour lifetime at a higher cache-write price. Our
  anthropic plugin sends 5-minute ephemeral markers only.
- **OpenAI**: automatic prefix caching on longer prompts; short-lived (minutes of inactivity,
  sometimes longer), no lifetime the caller sets.
- **DeepSeek**: automatic, disk-backed context caching; best-effort, typically kept for hours.
- **Gemini**: implicit caching on recent models, plus explicit cached contents with a
  caller-chosen TTL that is billed for storage.
- **Bailian**: our plugin sends explicit 5-minute ephemeral markers (implicit caching did not hit
  in our live check).

Contract additions (additive, in `packages/plugin-sdk/src/model.ts`):

- `ModelInfo.promptCache?: { mode: "none" | "automatic" | "explicit"; ttlSeconds?: number }`:
  `mode` says whether the model caches at all and whether the request decides it; `ttlSeconds` is
  the approximate lifetime of an entry after its last use, when the vendor documents one and it
  does not depend on the request. Absent = unknown, treated as `none` for timing.
- `ModelUsage.cacheTtlSeconds?: number`: the lifetime the call actually requested or got, when it
  depends on the request (Anthropic 5 min vs 1 h). Claude Code also works from the last request's
  actual TTL, not a model-level constant. The kernel records it on the call's `usage` event
  (additive; not model-visible; no `DriftReason`).
- Which TTL a provider requests (Anthropic 1 h) is the provider plugin's parameter (a declared
  param, so org/agent can choose it), not the kernel's; the 1-hour write price is the trade-off the
  admin makes there.
- The kernel never creates vendor-side explicit caches (Gemini cached contents) for this; storage
  billed per hour is out of scope.

Public API: `pnpm gen:sdk-api` plus a changeset bumping `@capybara-hq/plugin-sdk`
(`check:sdk-api`, `check:api-changeset`); the conformance suite gains a check that a declared
`ttlSeconds` / reported `cacheTtlSeconds` is a positive integer. Provider plugins (anthropic,
bailian, openai, deepseek, openai-compatible) declare in `capybara-hq/plugins`.

### 9.3 A summary request that reuses the cached prefix ("in-context summary")

Today's summary request is `[instruction] + transcript text`, chunked when it is large. The
in-context variant follows the prompt suggestions technique (`conversations/prompt-suggestion-request.ts`):

- Rebuild the conversation's **last request exactly as recorded** (the eval zero-drift path:
  `reconstructInputs` / `assembleModelRequest`), append the last assistant reply, then one user
  message with the summary instruction (the Claude Code template, adapted: "summarize the
  conversation above" instead of "the transcript below"). Same model, same system, same tool
  definitions (kept for the prefix; the instruction forbids tool calls and a tool call in the reply
  fails the attempt), so the provider's cache serves everything up to the instruction.
- **When it applies**: the same model as the conversation's last call (a model switch breaks the
  prefix, like Claude Code's guard); the rebuild has no drift (else fall back); and it fits: last
  request + reply + instruction + `maxOutputTokens` + reserve `<= W`. Every sent request already
  fits `W - O_p - R_p` (compaction spec §4.3), and the summary cap (20k) is usually below `O_p`, so
  it usually fits when the last reply is not huge.
- **Otherwise** the transcript path, chunked when needed (§4.5), exactly as today. Chunking and the
  in-context summary do not combine: chunking exists because the material exceeds one request;
  the in-context request is by construction one request the model already accepted. A history
  too large for one request has no cached prefix to reuse in one call anyway.
- **Coverage stays the plan's.** The summary still covers the plan's prefix (`coversUpToSeq`,
  `openingSeqs`); the model sees the kept tail too, and the instruction says to summarize only up
  to a marked point (the last event the plan covers is identified in the instruction) so the kept
  turns are not duplicated into the summary. The builder tests this boundary carefully; if the
  model cannot be held to it, the summary covers everything and the kept tail is empty (a builder
  decision recorded in the phase 2 plan).
- **Append-only history and replay.** The summary request is a side request, not a step: it adds
  nothing to the conversation's history and does not change any later request's prefix. Its result
  is the ordinary `compaction_summary` text, which is what later requests and replays use; replays
  never re-run the summary request. `compaction_summary` gains an optional `method: "transcript" |
  "in_context"` for observability (not model-visible, no `DriftReason`). The in-context request
  sees what the transcript omits (images, plugin context, project root), so summaries may differ in
  quality; zero drift is unaffected because the summary is read from the log.
- **Usage and hooks**: `model.request` fires with purpose `compaction` as today; `usage` shows the
  cache reads, which is how the benefit is measured.

The in-context summary is useful for **every** compaction (inline, manual, idle), not only idle:
any compaction right after a step finds a warm cache. Phase 2b should use it for all of them.

It also helps with the fixed delay alone: for providers with long automatic caches (DeepSeek), a
10-minute idle compaction already reads a warm prefix.

### 9.4 Fire timing against the cache

When the conversation's last call has a known lifetime `L` (its recorded `cacheTtlSeconds`, else
the model's declared `promptCache.ttlSeconds`) **and** the in-context summary applies (9.3):

- `runAt = lastCallFinishedAt + 0.9 * L`, if `0.9 * L >= IDLE_CACHE_MIN_SECONDS` (30 min);
- otherwise the fixed delay.

Short caches (5 min) keep the fixed delay: compacting at 4.5 minutes of idle time catches people
still reading (Claude Code does not use its 5-minute cache for this either), and after 5 minutes
the cache is gone, so the summary reverts to full price. Long caches (1 h, or a provider's
documented hours) fire just before expiry.

The arm-time decision is a best guess (the in-context fit is re-checked at fire). The job data
gains `{ timing: "cache" | "fixed", expiresAt? }`.

### 9.5 Phase 2 guards and settings

- A new guard for cache timing: if the job starts after `expiresAt` (worker backlog), it falls back
  to the fixed-delay behavior (the cache is gone; compacting is still worth the latency) unless the
  fixed delay would not yet have fired.
- `idleTiming: "fixed" | "cache"` (platform + org, default `cache`): `fixed` keeps phase 1
  timing even where the cache allows otherwise (an admin who prefers a predictable delay).

### 9.6 Phase boundaries (recommended)

| Phase | Content | Behavior change |
|---|---|---|
| 1 | idle job, guards, idle compact run, preemption, settings, personal opt-out, UI, logs | idle compaction at a fixed delay |
| 2a | SDK `promptCache` / `cacheTtlSeconds`, kernel records them, provider plugins declare/report | none (observability) |
| 2b | in-context summary for all compactions, `compaction_summary.method` | cheaper, faster summaries where the cache is warm |
| 2c | cache-timed fire (`idleTiming`), Anthropic 1 h as a provider param | idle compaction near cache expiry on long caches |

2a is cheap and gives the data to decide 2b/2c (how often caches hit, which TTLs are in use). 2c
should be built only if phase 1's `idle_return` logs show many returns between the fixed delay and
an hour, where a cache-timed summary would have been both cheap and in time.

## 10. Rollout

1. Phase 1 lands with `idleEnabled` default `true` (Q1) behind the existing compaction settings;
   the release notes call out the cost (§8.2) and the switches.
2. On prod, read the `IdleCompaction` and `idle_return` logs for two weeks: fire outcomes,
   preemption rate, return rate, the inline compactions avoided.
3. Adjust the default delay and `idleMinTokens` from the data; decide 2a–2c.

The change affects images only through the kernel: a changeset on `@capybara-hq/capybara` (and
`@capybara-hq/kernel` as the release process requires); phase 2a adds the SDK changeset.

## 11. Tests

Per the test portfolio: unit tests need no database (and join `packages/kernel/test/unit-tests.json`
in the same change), integration tests are one app per file (the default), dual-replica tests join
`packages/kernel/test/container-tests.json`.

Unit (`unit-tests.json`):

- `idleCompactionDecision`: each guard 1–9 and its outcome, the order, the trigger-line vs
  `idleMinTokens` minimum, the growth floor, staleness.
- Arming predicate: kind, trigger (`schedule` / `compact` excluded), outcome (`budget`, `failed`,
  `aborted`, suspended excluded), settings off.
- Settings: the three fields' defaults, ranges, merge (org over platform, `null` clears), strict
  patches; `PreferencesSchema.idleCompaction`.
- Phase 2 (when built): fire-time calculation (recorded TTL over declared, the 30-min floor,
  fallback), in-context applicability (model switch, drift, fit).

Integration (default project; prefer extending existing files over new ≤5-test files):

- Run finish owes the outbox row (with `OUTBOX_DISPATCH_FAILS`: queue, name, job id, data,
  `org_id`, `run_at`), then `drainOutbox` → an idle compact run → `compaction_summary`, usage
  purpose `compaction`, `model.request` hook fired, `run_started.compactOrigin: "idle"`, trigger
  account = owner.
- Obsolete: a message after the arming run → no run. Busy / disabled (platform, org, personal) /
  small / backoff / sub-agent / eval / schedule run → no run, no event.
- Preemption: a message during a running idle compact run (model-fake holding the summary call) →
  `run_aborted.reason: "superseded"`, no summary, then the message's run starts and compacts
  inline if over the line; a queued idle run aborted before claim; a manual compact request returns
  the idle run's id.
- HTTP: platform and org settings patches with the new fields (ranges, follow-platform), `PUT
  /me/preferences` with `idleCompaction`; `platform-parity.test.ts` stays green.
- Replay: the two `reconstruct.test.ts` cases (§8.3); eval planning skips an idle compact run.
- Web: settings sections, account preference, the divider variant and the background compacting
  row (`renderRouteWithCache`), i18n keys in zh and en, `check:web-ui`.

Container (`container-tests.json`, only what one replica cannot show):

- Two workers: a duplicated delivery of the same idle job starts one run.
- A message accepted on replica A preempts the idle compact run on replica B (cross-replica abort).

## 12. Open questions (with recommended answers)

1. **Default on or off?** Recommend **on** (Claude Code defaults on; the cost is bounded by §8.2
   and above the trigger line was owed anyway), with the rollout measurement (§10). If the
   maintainer prefers caution on cost, ship default off and turn it on after the data.
2. **Delay default.** Recommend **10 minutes**; revisit from `idle_return` data.
3. **Preempt always, or let an over-the-line idle run finish?** Recommend **preempt always**
   (§5.2): simpler, never longer than inline, waste bounded.
4. **Per-conversation switch?** Recommend **no** in phase 1 (personal + org + platform are enough;
   a per-conversation flag needs a new route and title-menu entry).
5. **Usage split by origin in admin views?** Recommend **later**: phase 1 logs suffice to decide.
6. **Queue.** Recommend `cap-kernel-maintenance` (one consumer, concurrency 5) with a named job:
   the job only reads, estimates and starts a run (the summary itself runs on the run queue), so
   it is short; a dedicated queue only if measurements show it delaying other maintenance work.
7. **Arming for `background_task` / `subagent` wakes.** Recommend **yes** (they continue a
   conversation a person reads); **no** for `schedule`.
8. **Phase 2 ordering.** Recommend 2a now-ish (cheap, data), 2b next (benefits all compactions),
   2c only if the data shows returns in the 10–60 min window.
9. **In-context summary boundary (9.3).** Whether the model can be held to "summarize up to the
   marked point" reliably enough to keep the kept tail; decide in the phase 2 plan with an eval.

## AGENTS.md rules touched

- **Multi-replica discipline:** a new delayed job (`idle-compaction`, id `idle-compact-<runId>`, no
  `:`) owed through the outbox in the run-finish transaction, BullMQ as the timer, consumed under
  `WorkerModule` inside `runJob` (org scope from `orgId`); no in-process timer; the idle compact run
  is started under the conversation row lock and excluded from ordinary runs by the run claim;
  preemption uses the existing cross-replica abort channel (§4.1, §5.1, §5.2).
- **Runtime and replay:** idle compaction writes an ordinary `compaction_summary`; no new
  model-visible input, no `DriftReason`; `run_started.compactOrigin` and `run_aborted.reason:
  "superseded"` are not model-visible; phase 2's `compaction_summary.method` and
  `usage.cacheTtlSeconds` likewise (§8.3, §9.3).
- **Migrations:** one additive column `runs.compact_origin` (§5.7).
- **Config / settings:** three compaction fields (platform default, org override) and a personal
  preference; phase 2 one more (§6).
- **Platform tool:** no new route; the fields join the shared schemas the existing operations are
  built from (§6.2).
- **Web UI / language:** settings fields, an account preference, a divider variant, i18n zh / en
  with 智能体 / 平台 (§6.4).
- **Model providers (phase 2):** model-provider@2 gains `ModelInfo.promptCache` and
  `ModelUsage.cacheTtlSeconds`; public SDK API: `gen:sdk-api` plus a changeset (§9.2).
- **Tests:** new unit and container tests join their checked-in lists in the same change (§11).
