# Idle compaction

Status: design, for maintainer review (2026-11-27; revised the same day with the maintainer's
decisions, recorded in §12). Issue #955. Builds on the context compaction design
(`2026-11-14-context-compaction-design.md`, cited as "compaction spec §n"), whose §2 and §6 listed
background precomputation as a non-goal / deferred item; this spec takes it up in a form that keeps
compaction synchronous and in the event log.

## 1. Why, and the core rule

A long chat conversation often crosses the compaction line during its last step: the final
assistant reply and tool results land after the step-boundary check (compaction spec §4.1), so the
conversation is over the line when the run ends. The person's next message then waits for the
summary request (tens of seconds; longer when it is chunked, §4.5) before the agent starts
answering. And if the person returns after the provider's prompt cache has expired, that next
request also re-reads the whole large context at full price, only to compact it.

Claude Code (2.1.332) arms a timer at every turn end and, when the session has been idle for most
of the prompt cache's lifetime, compacts in the background. Its motive is twofold:

1. **Cache cost.** Its summary request reuses the conversation's cached prefix, so summarizing just
   before the cache expires is cheap, and the returning person avoids a full-price re-read of a
   large context followed by an immediate compaction. It therefore fires at 90% of the cache
   lifetime and only with the 1-hour cache, not the 5-minute one.
2. **Latency.** The returning person does not wait for a compaction.

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

**Core rule (maintainer decision, 2026-11-27): idle compaction exists only to beat a cache
expiry, and only for caches that live at least 30 minutes.**

- The only trigger is "before the cache expires": fire at `t0 + 0.9 × L`, where `t0` is the start
  of the conversation's last request that read or wrote the cache and `L` that request's cache
  lifetime, and never later than 30 s before the expiry (§4.4, §9.3).
- `L < 30 min` (a 5-minute cache) never gets idle compaction: it would fire minutes after every
  turn, for no gain a returning person would notice.
- There is **no fixed-delay, latency-only mode.** Without a warm cache, compacting while idle only
  moves a full-price summary earlier and pays it even when nobody returns.
- Two prerequisites, therefore built first:
  1. **Cache declaration and kernel-derived expiry** (§9.2–§9.3): the kernel must know the lifetime
     a request actually used. No vendor reports an expiry, so the kernel derives it.
  2. **An in-context summary that reuses the cached prefix** (§9.4): today's summary request
     (`buildCompactionRequest`) replaces the system prompt, sends `tools: []` and a transcript, so
     it shares no prefix with any provider's cache; compacting "before expiry" with it saves
     nothing.

**Precondition in practice.** The kernel sends each model's default cache lifetime unless an admin
turns on the long tier (`promptCache.longTtl`, default **off**, §6.1). The defaults of the
explicit-cache vendors we use are 5 minutes (Anthropic, Bailian), so with the default settings
**no Anthropic or Bailian request has a cache of 30 minutes or more, and idle compaction does not
run for them**; it runs where an admin turns on the long cache tier. Re-checked exception: OpenAI
GPT-5.6 and later default to the `30m` tier (a minimum lifetime) when the request names none, so
those models qualify without `longTtl` once the openai plugin declares it; earlier OpenAI models
default to `in_memory` (about 5–10 minutes idle) or `24h` retention that is "often about 30
minutes" with no guarantee, and do not qualify (§9.1). `idleEnabled` defaults to on, so idle
compaction starts wherever this precondition holds.

**Phases (maintainer decision Q8):**

| Phase | Content | Behavior change |
|---|---|---|
| 1 | SDK cache declaration, `ModelRequest.cacheTtl`, `ModelUsage.cacheWriteByTtl`, `promptCache.longTtl`, kernel-derived expiry (§9.2–§9.3); the in-context summary for every compaction (§9.4); provider plugins declare (§9.5) | cheaper summaries where the cache is warm; correct cache-write costs; long tier available |
| 2 | idle compaction (§3–§8) | background compaction before a ≥ 30 min cache expires |

Phase 2 depends on phase 1 and is built after it.

## 2. Goals and non-goals

Goals:

1. A person returning to a long idle chat conversation neither waits for a compaction nor pays a
   full-price re-read the kernel could have avoided while the cache was warm.
2. Bounded cost: idle compaction runs only where the summary is cheap (warm cache, prefix reused),
   only on large conversations, at most once per finished run, never on conversations nobody
   started by hand.
3. Multi-replica safe, in the event log, replayable, with no new model-visible input.
4. Platform default, org override, personal opt-out.
5. Provider-neutral: cache behavior comes from per-model declarations, never hard-coded.

Non-goals:

- **A fixed-delay or latency-only mode** (maintainer decision; §1).
- **Idle compaction on caches under 30 minutes**, or on implicit / best-effort caches with no
  lifetime (DeepSeek, Bailian implicit, Ark implicit).
- **Precompute and swap** (Claude Code's mode b). See §5.6: the event log makes it unnecessary.
- **A new compaction algorithm.** Idle compaction is the existing compaction (plan, summary
  template, fit guard) with the in-context request of §9.4, started at another moment.
- **Compaction of sub-agent and eval conversations.** They take no compaction today (compaction
  spec §4.7; `ForceCompactionInput.conversationKind: "chat"`), and they gain none.
- **Presence or typing signals.** The kernel has no "person is reading / typing" signal; a new
  message preempts an idle compaction instead (§5.5).
- **Vendor-side stored caches** (Ark explicit cache, cached-content APIs billed per hour).

Anti-goals: an idle compaction that delays a person's message more than an inline one would; a
summary held outside the event log; a second timer mechanism beside BullMQ; a job enqueued for
every run whether or not it can ever fire.

## 3. Chosen approach

**Idle compaction = an automatic compact run**, started by a delayed job that is owed at run
finish only when cheap arm-time checks pass.

```
run finishes (chat, eligible trigger + outcome)
  └─ arm-time checks (settings, last request's cache ≥ 30 min, size, outcome) fail ─▶ nothing owed
  └─ pass ─▶ same transaction: outbox row idle-compact-<runId>, runAt = t0 + 0.9 × L
       └─ job fires (worker, runJob, org scope)
            ├─ fire-time re-checks fail ─▶ log the outcome, done (no event written)
            └─ pass ─▶ start an idle compact run (conversation row lock, re-check)
                 └─ run worker: the compact path with the in-context summary (§9.4)
                      ├─ compaction_summary + usage ─▶ run_finished
                      └─ a person's message arrives ─▶ aborted (superseded); the message's run follows
```

It reuses everything manual compaction (compaction spec §4.7) already has: the `runs.compact` run
path in the run worker, mutual exclusion with ordinary runs through the run claim, progress (§4.6),
the summary's usage and hooks, abort without a partial summary. What it adds is the arm-time filter,
the job that re-checks *whether*, the cache-derived *when*, and preemption.

Rejected:

- **B. Compute the summary inside the job, outside a run.** It would write `compaction_summary`
  without the run claim, racing a step that compacts or appends at the same time; the summary's
  coverage (`coversUpToSeq`) could then fall behind or interleave with a running step. The run
  claim already solves this.
- **C. A periodic sweep over idle conversations** (`@LockedInterval` scanning for conversations
  whose cache is about to expire). Works without arming, but scans every org's conversations each
  tick and fires late by up to a tick, which can miss a cache expiry. A delayed job owed only when
  it can fire is cheaper and exact.
- **D. Precompute and swap** (§5.6).
- **E. A fixed idle delay** (the first draft's phase 1). Rejected by the maintainer: without a
  cache benefit it only moves a full-price summary earlier.

## 4. Trigger and guards

### 4.1 Size threshold

`idleMinTokens(W) = max(idleMinTokensFloor, idleMinWindowRatio × W)`, defaults
`max(200000, 0.3 × W)`, where `W` is the context window of the conversation's model. The size
compared is the next request's estimate (arm time: the last call's actual input plus its output,
§4.2; fire time: the calibrated estimate, §4.3).

What this means per window (trigger line from compaction spec §4.1, `min(0.8 W, W − O_p − R_p)`
with the defaults `O = 32k`, `R = 8k`):

| Window `W` | Idle threshold | Inline trigger line | Idle compaction |
|---|---|---|---|
| 128k | 200k | ≈ 88k | never (threshold above the window) |
| 200k | 200k | 160k | never (the inline trigger at about 0.8 W comes first; an estimate cannot reach 200k) |
| 256k | 200k | ≈ 205k | almost never (only between 200k and ≈ 205k) |
| 400k | 200k | 320k | 200k–320k |
| 1M | 300k | 800k | 300k–800k |

**This is intentional and matches Claude Code**, whose 200k floor never fires for sessions with a
200k window. Below 200k, a full-price re-read or an inline compaction is cheap enough not to be
worth a background call; idle compaction is for large-window models carrying a large context.

Both numbers are settings with these defaults (§6.1), not constants: a deployment on cheap models
may lower the floor, an org may raise it; the defaults encode the maintainer's rule.

### 4.2 Arming: cheap checks at run end, nothing owed when they fail

At run finish (`RunFinish.finishIn`), before owing anything, the kernel checks facts it already
holds in memory or in the rows the finish reads; if any fails, **no job is owed at all**:

1. **Kind and trigger.** `kind = 'chat'` (not sub-agent, not eval); `run_started.trigger` is
   `message`, `background_task` or `subagent` (wakes continuing a conversation a person started);
   not `schedule` (a scheduled task's conversation is often never read again) and not `compact`.
2. **Outcome.** `completed`, `max_steps`, `max_duration` or `max_output`; not `budget` (the run
   stopped to save money), `failed`, `aborted`, nor a suspended run (not terminal).
3. **Settings.** Effective `enabled` and `idleEnabled` (platform + org) and the owner's preference
   not off (§6.3).
4. **Cache lifetime.** The run's last request that read or wrote the cache (§9.3) exists, its model
   declares `mechanism: "explicit"` or an implicit mechanism with a declared lifetime floor, and its
   lifetime `L` (the recorded `cacheTtl`, else the model's `defaultTtl`) is **≥ 1800 s**.
5. **Size.** The last call's actual input (`inputTokens + cacheReadTokens + cacheWriteTokens`) plus
   its output tokens is `≥ idleMinTokens(W)`.

When all pass, one outbox row (`OutboxService.add`, writing-kernel-api "Owed work") in the same
transaction:

- queue `cap-kernel-maintenance` (one consumer, `MaintenanceProcessor`, concurrency 5, dispatches
  by name; decision Q6), name `idle-compaction`, job id `idle-compact-<runId>` (no `:`; one per
  finished run, so owing it twice is a no-op);
- data `{ orgId, conversationId, runId, armedSeq, cacheCallSeq, expiresAt }`: `armedSeq` is the
  conversation's highest seq written by the finish (the `run_finished` event), `cacheCallSeq` the
  `model_call` the expiry was derived from, `expiresAt` that expiry;
- `runAt = min(t0 + 0.9 × L, expiresAt − 30 s)` (§9.3); `orgId` set, so an org's deletion removes
  the pending row.

Why the outbox and not an `afterCommit` hint (prompt suggestions enqueue as a hint): losing one
idle compaction is harmless, but this is *delayed* work, and the outbox relay is the sanctioned way
to give BullMQ a future job (`kc-enqueue-via-outbox`); a hint would need a new `KC_EXCEPTIONS` entry
and still a delayed `add`.

Registry entry (`OUTBOX_JOBS`): `idempotent`: "the job re-reads the conversation and starts at most
one idle compact run under the conversation row lock, only while the conversation's latest seq is
still `armedSeq`; a duplicate delivery finds the seq advanced (by the first delivery's run) or an
active compact run and does nothing"; `opts`: `attempts: 2`, short backoff, `removeOnComplete:
true`.

The arm-time checks are a pure function (`idleArmDecision(...)`) over the run's facts, the settings
and the model declaration; the finish only calls it.

### 4.3 Re-checks when the job fires

The job runs inside `runJob` (org scope from `orgId`), on the worker role, and checks in this order;
the first failing check ends it with that outcome (§7) and writes no event:

| # | Check | Outcome |
|---|---|---|
| 1 | org live; conversation live, `kind = 'chat'`; agent not deleted | `gone` |
| 2 | latest event seq of the conversation `== armedSeq` | `obsolete` |
| 3 | no active run (queued, running, suspended); no unconsumed message; queue head empty | `busy` |
| 4 | effective `enabled` and `idleEnabled` (live); owner's preference not off | `disabled` |
| 5 | the cache is still warm: `now < expiresAt − 30 s` (the job is not late: worker backlog, outage) | `expired` |
| 6 | the latest compaction record after the latest summary is not a `compaction_failed` (respect the failure backoff) | `backoff` |
| 7 | the effective definition's model is enabled for the org, resolvable, and the same model as the `cacheCallSeq` call (a switch breaks the prefix) | `no_model` |
| 8 | size: the calibrated estimate of the next request `>= idleMinTokens(W)`, and the part the plan would summarize (not yet covered by a summary) `>= IDLE_MIN_GROWTH_TOKENS` (20k) with a non-empty plan | `small` |
| 9 | the in-context summary applies (§9.4: no drift in the rebuild, it fits the window) | `no_prefix` |

Then it starts the run (§5.1); a refusal there (a message arrived in between) is `obsolete` / `busy`.

Notes:

- **Cache warm (5)** is Claude Code's "cache lapsed / timer late" guard. A late job compacting a
  cold cache would pay full price, which is exactly what the core rule forbids, so it ends.
- **In-context only (9).** Idle compaction never falls back to the transcript request: that request
  reuses no cache, so it would be the full-price background summary the core rule rules out. The
  inline and manual compactions keep their transcript fallback.
- **Growth (8)** stops a conversation that was just compacted from being compacted again for a few
  tokens.
- **No rate-limit guard.** The kernel has no provider rate-limit signal; a provider error fails the
  compaction like any other (`compaction_failed`, which then blocks later idle attempts through
  check 6 until a summary succeeds).

The re-checks are a pure function too (`idleFireDecision(...)`), unit-tested on its own.

### 4.4 Re-arm and cancel

There is no cancellation. Every finished run that passes §4.2 owes its own job; an earlier job that
fires after a later run finds the conversation's latest seq above its `armedSeq` and ends as
`obsolete`. Any event appended after the arming run (a new message, a queued message, a model
switch, a permission profile change) makes the job obsolete; the later run, if it passes §4.2, arms
its own. Each later request that hits the cache refreshes it (`refreshOnHit`), so the newer job's
`runAt` is also the right one. Cancelling BullMQ delayed jobs from the run path would add a Redis
call to a hot transaction path for no gain.

## 5. Job and run lifecycle

### 5.1 Starting the idle compact run

`RunQueue.startIdleCompaction(conversationId, armedSeq)`, a sibling of `startCompaction`
(`runtime/run-queue.ts`), in one `@Transactional({ propagation: "requires_new" })` method under the
conversation row lock (the lock `ensureRun` takes):

- re-check checks 1–3 under the lock (latest seq still `armedSeq`, no active run, no unconsumed
  message); a refusal returns null, never throws (the job is not an API call);
- insert the run row as `startCompaction` does (`compact: true`, `trigger_seq = consumed_seq`, the
  deterministic run job id via `jobIdFor`, owed through the outbox), with `compact_origin = 'idle'`
  (a new column, §5.7) and `trigger_account_id` = the conversation's owner
  (`conversations.account_id`): usage, hooks and audit attribute the calls to the person whose
  conversation it is;
- the run worker takes the compact path (`CompactionService.force`, `step: 0`) with the in-context
  request required (`method: "in_context"`; if it no longer applies when the run starts, the run
  writes nothing and finishes `completed`).

`run_started` carries `trigger: "compact"` (unchanged, so every reader that skips compact runs:
channels' progress, prompt suggestions, eval planning, keeps working) plus a new optional
`compactOrigin: "idle"` (absent = manual), display only (§6.4, §8).

### 5.2 Race with a new message: preemption (decision Q3)

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
- The message's run compacts inline if it needs to (it would have anyway; the cache is still warm,
  so its in-context summary is cheap too). The summary call already made is billed and recorded.
- If the abort arrives after the `compaction_summary` was written (the `writing` phase), the summary
  stands: it is a valid summary in the log, the run ends aborted, and the next step uses it.
- A **manual** compact request while an idle compact run is active returns the idle run's id (the
  existing "a compact run already queued or running: the same request again"); the person then
  watches it finish. A manual compact run is never preempted.
- Background wakes (`background_task`, sub-agent deliveries) are input like a message: they
  preempt too. A scheduled task's message into a chat conversation also preempts.

### 5.3 Fire timing

`runAt = min(t0 + 0.9 × L, expiresAt − 30 s)`, with `L ≥ 30 min`, so the job fires 27 minutes or
more after the last cache-touching request started (27 min for OpenAI's `30m`, 54 min for a 1-hour
tier). The derivation (`t0`, `L`, refresh rules) is §9.3.

### 5.4 Abort, shutdown, failure

- Shutdown or a lost lease during an idle compact run: as for a manual one (`interrupted`, the job
  goes back to another replica, which re-runs the compaction if the cache is still warm; the
  summary's idempotency keys are the run id and ordinal, compaction spec §4.4).
- A failed compaction writes `compaction_failed` and the run finishes `completed`, exactly as a
  manual one; check 6 blocks idle attempts until a summary succeeds.
- Org deletion: the outbox row goes with the org; a run already started is aborted by the existing
  org-deletion path (`org_deleted`).

### 5.5 Why no "person interacted within 60 s" guard

Claude Code refuses when the user interacted within 60 s because its compaction shares the
process with the person's input. In Capybara the guard is structural: any input appends an event
(the job is then obsolete) or arrives during the run (it preempts it). And the job fires 27 minutes
or more after the last request started.

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

### 5.7 Data changes (phase 2)

- Migration `NNNN_idle_compaction.sql`: `ALTER TABLE runs ADD COLUMN IF NOT EXISTS compact_origin
  text NULL` with a check (`'manual' | 'idle'`, null for ordinary runs; existing compact runs read
  as manual). `runs` has no `org_id` of its own (org via the conversation), so no RLS change; the
  builder confirms against `check:org-filter`.
- Events (`conversations/events.ts`): `run_started.compactOrigin?: "manual" | "idle"`;
  `run_aborted.reason` gains `"superseded"`. Additive; old logs parse.
- Phase 1's event changes are in §9 (`model_call.request.cacheTtl`, `compaction_summary.method`).

## 6. Settings and UI

### 6.1 Platform and org

Idle compaction fields join `COMPACTION_FIELDS` (`identity/settings.ts`), flat so the existing
field-by-field `effectiveCompactionSettings` merge, the org "follow platform" state and the
`null`-clears patch semantics carry over unchanged:

| Field | Default | Range | Meaning |
|---|---|---|---|
| `idleEnabled` | `true` (Q1) | boolean | compact idle conversations before a ≥ 30 min cache expires |
| `idleMinTokensFloor` | 200000 | 50000–2000000 | the size floor of §4.1 |
| `idleMinWindowRatio` | 0.3 | 0.1–0.9 | the share of the window of §4.1 |

There is no delay field: the timing comes from the cache (§5.3). `enabled: false` (automatic
compaction off) also turns idle compaction off. Manual compaction stays available whatever these
say.

Phase 1 adds a separate platform / org group, `promptCache`:

| Field | Default | Meaning |
|---|---|---|
| `promptCache.longTtl` | `false` (Q10) | chat requests ask for the model's shortest cache tier of at least 30 minutes (Anthropic `1h`, Qwen4 `1h`; OpenAI 5.6+ `30m` is already the default) instead of its default; every cache write then costs the long tier's price |

`promptCache` lives in `DeploymentSettings` and org settings like `compaction` (org > platform >
built-in), read per request by request building, recorded per request as `cacheTtl` (§9.2). It is
the precondition for idle compaction on Anthropic and Bailian models (§1).

### 6.2 Platform tool parity

No new route. The fields join existing shared schemas (`COMPACTION_SETTINGS`,
`COMPACTION_SETTINGS_PATCH`, `DEPLOYMENT_SETTINGS_PATCH`, the org settings patch), which the
existing Platform operations (`admin.settings` / `admin.update-settings`, `org-settings.get` /
`org-settings.update`) are built from; `platform-parity.test.ts` covers them through the shared
schema. Same for the personal preference (§6.3), which joins `PreferencesSchema` behind the
existing `GET` / `PUT /api/v1/me/preferences` operations. `pnpm check:platform-ops` must stay green;
no exclusion is added.

### 6.3 Personal opt-out

`PreferencesSchema` gains `idleCompaction: "off" | null` (null = follow the org). Checked at arm
time and at fire time against the conversation's owner. A person who wants every detail kept
verbatim until they come back, or who does not want background model calls in their name, turns it
off in their account preferences (a switch in the existing preferences form). It is a narrowing
only: a person cannot turn idle compaction on where the org has it off.

No per-conversation switch (decision Q4).

### 6.4 UI

- **Settings pages.** The existing "Conversation compaction" section on the platform settings page
  and the org settings page (design components only, `check:web-ui`) gains the three fields (the
  two size fields disabled while `idleEnabled` is off); a new "Prompt cache" section holds
  `longTtl`. zh / en:
  - `compaction.idleEnabled`: "缓存过期前在后台压缩" / "Compact idle conversations before the cache
    expires"; hint "对话空闲时，在模型的提示缓存过期前用缓存压缩，下次发消息时不必等待压缩，也不必全价重读
    长上下文。只对缓存至少 30 分钟的模型生效（大多数模型需要开启长缓存）。" / "While a conversation is
    idle, compact it from the prompt cache before the cache expires, so the next message neither
    waits for a compaction nor re-reads the long context at full price. Only for models whose cache
    lasts 30 minutes or more (most need the long cache tier)."
  - `compaction.idleMinTokensFloor`: "后台压缩的最小上下文" / "Smallest context to compact in the
    background"; help "上下文不少于这个数和窗口比例两者中较大者时才压缩（默认 200,000）。"
  - `compaction.idleMinWindowRatio`: "按窗口比例的最小上下文" / "Smallest context as a share of the
    window"; help "默认 0.3：1M 窗口的模型从 300,000 起。"
  - `promptCache.longTtl`: "长提示缓存" / "Long prompt cache"; hint "请求改用模型至少 30 分钟的缓存档
    （如 1 小时），缓存写入按长档计价（Anthropic 约为输入价的 2 倍，而 5 分钟档约 1.25 倍）。开启后空闲压缩
    才会在这些模型上运行。" / "Requests use the model's cache tier of at least 30 minutes (such as 1
    hour); cache writes are billed at the long tier's price (Anthropic about 2× the input price
    instead of 1.25×). Idle compaction runs on these models only with this on."
    Phase 1 ships this hint without its last sentence (zh "开启后空闲压缩才会在这些模型上运行。", en "Idle
    compaction runs on these models only with this on."), because UI copy does not describe a feature
    that has not shipped (decision D7, phase 1 plan); phase 2 restores it.
- **Account preferences.** "空闲时压缩我的对话" / "Compact my conversations while I'm away", with
  the org state shown when the org has it off ("组织已关闭").
- **Conversation page.** An idle compaction is quiet:
  - While it runs and the page is open, the existing compacting row (compaction spec §4.6) shows,
    labelled "正在后台压缩会话…" / "Compacting in the background…".
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

- **Arm decision**: not logged per run (hot path); the arm-skip reason is a `debug` line.
- **Job outcome**: one `info` log per job, `context=IdleCompaction`, `outcome` in `started | gone |
  obsolete | busy | disabled | expired | backoff | no_model | small | no_prefix`, with `orgId`,
  `conversationId`, `runId`, the estimate, `L`, and the lateness against `runAt`.
- **Run outcome**: from the log: `compaction_summary` (with `savedTokens`, `method`) or
  `compaction_failed`, or `run_aborted.reason: "superseded"`, all in runs with
  `compactOrigin: "idle"`; usage shows the cache reads.
- **Return after idle** (the value measure): when a run starts on a conversation whose previous
  run ended more than 30 min earlier and whose context at that end was at least `idleMinTokens(W)`,
  log `idle_return` with the gap, the cache lifetime then in use, whether an idle summary was
  written in between, and the step's inline compaction time if one ran. This also shows the
  opportunities the 30-minute rule leaves out (conversations on 5-minute caches).
- **Admin**: the super admin's usage views may later split compaction usage by origin (decision
  Q5: later).

## 8. Usage, hooks, cost, replay

### 8.1 Usage and hooks

The summary calls are ordinary compaction calls: `model.request` fires with the existing compaction
fields (a policy hook may deny and fails closed: `compaction_failed`), `usage` events with purpose
`compaction`, `model_usage` rows, `usage.report` delivered through the outbox. The trigger account
is the conversation's owner. No hook payload change.

### 8.2 Cost

- **An idle compaction** costs one in-context summary call: the conversation's prefix at the
  cache-read price (about 0.1× of input or less on the qualifying vendors) plus up to
  `maxOutputTokens` (20k) of output. On a conversation the person never returns to, that is the
  whole extra cost.
- **What it saves** on a return: the full-price re-read of a cold large context and, when over the
  line, a full-price inline summary.
- **The long tier is the bigger lever**: with `promptCache.longTtl` on, every cache write of every
  chat request costs the long tier's price (Anthropic 2× instead of 1.25× of input). That is why it
  is off by default and an admin's choice per platform / org.
- Bounds: at most one idle compaction per finished run that passed the arm checks; only for
  person-started runs and their wakes; only on large contexts of large-window models (§4.1); never
  on a cold cache; never retried after a failure; never after a `budget` stop; platform, org and
  person can turn it off.

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

## 9. Phase 1: provider cache contract and the in-context summary

### 9.1 Why both, and why first

**A cache declaration alone buys nothing.** Today's summary request
(`runtime/context/compaction.ts` `buildCompactionRequest`) replaces the system prompt with the
compaction instruction (`cache: false`), sends `tools: []` and one user message holding a transcript
of the events (chunked when large, compaction spec §4.5). It shares **no prefix** with any of the
conversation's requests, so no provider can serve it from cache, whatever the provider caches and
however precisely the kernel knows the expiry. Conversely, a prefix-reusing summary without a known
expiry cannot be timed. Idle compaction needs both; the in-context summary also makes every inline
and manual compaction cheaper on its own.

#### Provider landscape

Checked against the vendors' official documentation on 2026-11-27 and re-verified on 2026-11-28
(task P0: official pages read in full, plus live probes with raw HTTP; each fact cites its source;
"unverified" marks what neither the official pages nor a probe settled). Prices are relative to the
model's input price.

| Vendor / our plugin | Mechanism | Lifetime | Hit refreshes | Chosen per request | Qualifies (≥ 30 min)? |
|---|---|---|---|---|---|
| Anthropic (`anthropic`) | explicit `cache_control` breakpoints (≤ 4, a top-level automatic one counts) | 5 min default, or 1 h | yes, from the request's start | `cache_control.ttl: "1h"` | only with `1h` (`longTtl` on) |
| OpenAI, GPT-5.6 and later (`openai`, Responses) | implicit by default (automatic breakpoint at the latest message); explicit breakpoints optional | `prompt_cache_options.ttl` `30m` (default) or `12h`, a **minimum** | 30m: kept ≥ 30 min after a read; 12h: a read does not restart it | `prompt_cache_options.ttl` | **yes**, the default `30m` |
| OpenAI, earlier models | automatic prefix caching | `prompt_cache_retention` `in_memory` (about 5–10 min idle, at most 1 h) or `24h` (often about 30 min, at most 24 h) | in_memory counts idle time; 24h unverified (the page states no refresh rule) | `prompt_cache_retention` | no (a range, no guarantee) |
| DeepSeek (`deepseek`, openai-compatible `deepseek`) | automatic disk cache, best-effort | cleared hours to days after last use | not stated (no switch, no configurable lifetime) | no | no (best-effort, no lifetime) |
| Bailian explicit (`bailian`) | `cache_control: {type: "ephemeral"}` (≤ 4, 20-block lookback) | 5 min fixed; Qwen4 `5m` or `1h` | yes, each hit restarts it | general models: no; Qwen4: `prompt_cache_options.ttl` | Qwen4 `1h` only (`longTtl` on; works on the native `multimodal-generation` endpoint, verified live) |
| Bailian explicit on the compatible-mode endpoint (openai-compatible `qwen`, `cacheFields: "dashscope"` since plugins#304) | `cache_control` markers on the last system block and the last message block | 5 min, restarted by each hit | yes | no | no (5 min) |
| Bailian implicit (a request without markers; no plugin sends one) | automatic prefix, not guaranteed | no fixed lifetime, cleared periodically | not stated | no | no (no lifetime) |
| Ark implicit (`ark`, openai-compatible `ark`) | automatic on supported models, not guaranteed; `prompt_cache_key` only for routing affinity | no fixed lifetime, capacity eviction | not stated | no | no (no lifetime) |
| Ark explicit (Responses API only; our plugin uses Chat) | `caching.type=enabled`, session or prefix | `expire_at`, 3 days default, 7 max | no | `expire_at` | not applicable (Responses only; our plugin uses Chat) |

Sources and details:

- **Anthropic** ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)):
  explicit breakpoints, at most 4, the top-level `cache_control` is automatic caching and takes one
  slot; each breakpoint looks back at most 20 blocks; the prefix must match exactly. Default 5
  minutes, `"ttl": "1h"` for one hour; every hit resets the lifetime at no cost, counted from the
  **start** of the request that read or wrote the entry; a request that reads a 5-minute entry
  restarts its 5 minutes even if it asked for `1h`; 1 h entries must come before 5 min entries.
  Minimum cacheable length 512–4096 tokens depending on the model; shorter prompts are silently not
  cached; the per-model minimums are listed in the [Anthropic minimums](#anthropic-minimum-cacheable-length)
  below. Writes 1.25× (5 min) or 2× (1 h), reads 0.1× (0.05× on Opus 5.5 and Sonnet 5.5, 0.025× on
  Fable and Mythos 5.1 / 5.2). Usage reports
  `cache_read_input_tokens`, `cache_creation_input_tokens` and the split
  `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`. No response field
  states an expiry.
- **OpenAI** ([prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)):
  GPT-5.6 and later default to implicit mode with an automatic breakpoint at the end of the latest
  cacheable message; `prompt_cache_options.mode: "explicit"` uses only developer breakpoints
  (not allowed on `instructions`). `prompt_cache_options.ttl` is `"30m"` (default) or `"12h"` and is
  a minimum ("OpenAI may retain entries longer than the requested minimum"); a read keeps a 30m
  entry for at least another 30 minutes; a read does not restart the 12h clock. Reads 0.1× (0.05× on
  some models), writes 1.25× (30m) or 2.5× (12h); minimum 1024 tokens. Earlier models cache
  automatically with `prompt_cache_retention` `in_memory` or `24h` and no write surcharge. Usage
  reports `usage.input_tokens_details.cached_tokens`, `cache_write_tokens` and, on 5.6+,
  `cache_write_tokens_details.ttl_30m_tokens` / `ttl_12h_tokens` (the counts do not overlap and sum
  to `cache_write_tokens`; `cached_tokens` excludes tokens charged as writes). The page documents
  `prompt_cache_options` for Responses only and names no complete model list.
  Verified live (2026-11-28, raw HTTP; `gpt-5.6-luna`, `gpt-5.6-sol`; request shape
  `POST /v1/responses {store: false, instructions: <~5.8k tokens>, input, max_output_tokens: 16}`):
  - With **no** cache option the first request already writes at the 30m tier
    (`cache_write_tokens` 5811 = `ttl_30m_tokens` 5811, `ttl_12h_tokens` 0, `cached_tokens` 0), the
    second reads (`cached_tokens` 5803, `cache_write_tokens` 8 for the new tail). So the implicit
    default is a 30m write, billed at the write rate.
  - `prompt_cache_options: {ttl: "12h"}` writes `ttl_12h_tokens` (5812) and a second request reads
    it (`cached_tokens` 5804); `{ttl: "30m", mode: "implicit"}` is accepted.
  - **Chat Completions accepts `prompt_cache_options` on 5.6+** (`gpt-5.6-luna`: 200, usage has
    `cache_write_tokens` 5810 and `cached_tokens` but **no** `cache_write_tokens_details`), and
    **rejects it on `gpt-5.5`** (400 "prompt_cache_options is not supported on this model"). An
    option must therefore only be sent for 5.6+ ids.
  - Model ids the account lists: `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`,
    `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6.2-astra`, `gpt-6.2-sol` (and
    `-healthcare` variants); `gpt-5.5`, `gpt-5.4*`, `gpt-5.3-codex`, `gpt-5.2*`, `gpt-5.1`, `gpt-5*`
    are earlier (GPT-5.6 has no bare `gpt-5.6` id). "5.6 and later" is therefore the numeric prefix
    `gpt-<major>[.<minor>]` ≥ 5.6, a dated suffix not counting (`gpt-5.4-2026-03-05` is 5.4).
  - Prices ([pricing](https://developers.openai.com/api/docs/pricing), short context, per 1M tokens):
    30m write / 12h write `gpt-5.6-sol` $5.00 / $10.00, `gpt-5.6-terra` $2.50 / $5.00,
    `gpt-5.6-luna` $0.25 / $0.50 (long context twice that): the 1.25× / 2.5× ratios of the caching
    guide.
  - Still unverified: whether the 24h `prompt_cache_retention` tier refreshes on a hit (the guide
    states no rule for it) and its price (neither the guide nor the pricing page lists a surcharge
    or a price for it).
- **DeepSeek** ([context caching](https://api-docs.deepseek.com/guides/kv_cache),
  [pricing](https://api-docs.deepseek.com/quick_start/pricing)): on for everyone, no request
  option; prefix units saved at request boundaries; entries usually cleared "a few hours to a few
  days" after last use; best-effort. Hits cost about 2–3.3% of a miss; no write surcharge, no
  storage fee. Usage `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`. The page states **no**
  minimum length, no unit size ("fixed token intervals", no number), no isolation rule and no switch
  or setting for the lifetime. Measured live (2026-11-28, `deepseek-flash` via the DeepSeek API,
  `POST /chat/completions` with a system message of N lines then a short user message, repeated 6 s
  later): no hit at prompt sizes 57, 105, 153 and 249 tokens; first hit at a 262-token prompt
  (`prompt_cache_hit_tokens` 128); every hit a multiple of 128 (128 at 262–377, 256 at 423 and 489,
  768 at 969, 1792 at 1929, 3712 at 3866). So the unit is **128 tokens** and nothing smaller than
  about 256 tokens caches; the old "64 token" figure is not supported. This is a measurement, not a
  documented guarantee.
- **Bailian** ([context cache](https://help.aliyun.com/zh/model-studio/context-cache),
  [Qwen4 explicit cache](https://help.aliyun.com/en/model-studio/explicit-cache-qwen4)): implicit
  cache automatic, not guaranteed, no fixed lifetime, minimum 1024 (512 for GLM / MiniMax), hits
  usually 0.2×. Explicit cache `cache_control: {"type": "ephemeral"}`, 5 minutes, each hit restarts
  it, minimum 1024, at most 4 markers, 20-block lookback, writes 1.25×, hits 0.1×. **Explicit and
  implicit caching are mutually exclusive within one request.** Qwen4 adds `prompt_cache_options`
  `{mode, ttl}` with `5m` or `1h` (a hit renews by the current request's TTL and keeps the later
  expiry), writes about 1.25× / 2×, and a TTL split in usage. The Qwen4 page documents the option
  for Chat Completions (usage `prompt_tokens_details.cache_creation.ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens`), Responses (`cache_write_tokens_details.ttl_5m_tokens` /
  `ttl_1h_tokens`) and the Anthropic-compatible API (`cache_control.ttl`); it does not mention the
  native endpoint. Verified live (2026-11-28, `qwen4-max`, raw HTTP to
  `https://<workspace>.cn-beijing.maas.aliyuncs.com`, system prompt of ~4.6k tokens with a
  `cache_control: {type: "ephemeral"}` marker):
  - `qwen4-max` is **only served by `/api/v1/services/aigc/multimodal-generation/generation`**; the
    `text-generation` path answers 400 "url error" for it (with and without the option).
  - On the native endpoint the option goes in **`parameters.prompt_cache_options: {ttl: "1h"}`**:
    the write is reported as `usage.prompt_tokens_details.cache_creation.ephemeral_1h_input_tokens`
    4588 (and `ephemeral_5m_input_tokens` 0); a second request reads it (`cached_tokens` 4888). The
    same option at the **top level** of the body is accepted but ignored (a 5-minute write,
    `ephemeral_5m_input_tokens` 4588), so a wrong placement fails silently.
  - `cache_control: {type: "ephemeral", ttl: "1h"}` on the marker also works (a 1h write, a hit on
    the second request): the marker-level form is the simplest mapping for the plugin.
  - A request without the option (5m) or with `ttl: "5m"` that hits a 1h entry reads it and writes
    nothing new (`cache_creation` all 0); the entry's expiry is not shortened by the hit in any way
    these probes could show (not tested over an hour).
  - Usage field names on the native endpoint: `usage.prompt_tokens_details.cached_tokens`,
    `cache_type` (`"ephemeral"`), `cache_creation_input_tokens`, `cache_write_tokens`,
    `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`. `input_tokens`
    includes cached and written tokens (the plugin already subtracts both).
  - The explicit 5-minute cache restarts on a hit, live: `qwen-plus` on `text-generation`, prefix A
    written at 0 s, hit at 171 s, hit again at 362 s (190 s after the refresh, 362 s after the
    write): `cached_tokens` 4577; control prefix B written at 0 s and never hit: miss at 362 s
    (`cache_creation_input_tokens` 4727, `cached_tokens` 0).
  - openai-compatible `qwen` dialect (compatible-mode, `cache_control` markers on the last system
    block and the last message, plugins#304): **an explicit 5-minute cache, confirmed**. `qwen-plus`
    #1 `cache_creation_input_tokens` 4888 (`cache_type` `ephemeral`,
    `cache_creation.ephemeral_5m_input_tokens` 4888), #2 `cached_tokens` 4879 with 9 new written;
    `qwen3.8-flash` the same (5069 read of 5084). Two requests without markers on `qwen-plus` both
    reported `cached_tokens` 0, so the implicit cache did not hit there (the dialect's old
    "implicit" description no longer applies).
- **Ark** ([context cache](https://docs.volcengine.com/docs/ark/context-cache)): implicit cache on
  supported models, cannot be turned off, not guaranteed, no fixed lifetime (capacity and
  eviction), minimum 1024 by default (128–8960 on some models, listed by model id: 128 for
  `deepseek-v4-1-flash-261017` and `-economy-261017`; 256 for `deepseek-v4-1-flash-260910` and
  `kimi-k3-1-pro-261024`; 2048 for `doubao-seed-2-1-turbo-260628`, `glm-5-2-260617`,
  `deepseek-v4-pro-ga-260813` and `deepseek-v4-flash-ga-260731`; 8960 for `glm-5-3-flash-260828`);
  `prompt_cache_key` is a routing hint only; no separate storage fee for the implicit cache. Live
  (2026-11-28, `deepseek-v4-flash-ga-260731`, Chat API): no hit at 1107 and 1447 tokens, a hit of
  2048 at 3827 tokens, matching the 2048 threshold. Explicit cache only on the Responses API,
  `expire_at` default 3 days after creation, at most 7, use does not extend it, billed per natural
  hour of storage. Prices ([model pricing](https://docs.volcengine.com/docs/ark/model-pricing),
  online inference standard tier, CNY per 1M tokens): cache hit `deepseek-v4-pro` 0.30,
  `deepseek-v4-flash` 0.10, `doubao-seed-2.1-pro` 1.20, `-lite` 0.16, `-turbo` 0.60; explicit cache
  storage 0.017 per 1M tokens per hour on all of them. The older Context API
  ([create](https://docs.volcengine.com/docs/82379/1346559), page updated 2025-03-05): `ttl` default
  86400 s, range 3600–604800 s (1 h to 7 days), the countdown restarts on each use, `mode`
  `session` (default) or `common_prefix`; it is a separate legacy API our plugin does not use.

#### Anthropic minimum cacheable length

([prompt caching, "Cache limitations"](https://platform.claude.com/docs/en/build-with-claude/prompt-caching);
the page names models, not always the API id; ids below are as `GET /v1/models` lists them for our
test account on 2026-11-28.) The anthropic plugin's own default list is `claude-opus-5-5`,
`claude-sonnet-5-5`, `claude-haiku-5-5` (all 512); the model list is otherwise the deployment's
configured ids.

| `minTokens` | Model ids |
|---|---|
| 512 | `claude-fable-5-2`, `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` (and the Mythos 5 / 5.1 / 5.2 ids) |
| 1024 | `claude-opus-4-8`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-opus-4-1`, `claude-opus-4`, `claude-sonnet-4` |
| 2048 | `claude-opus-4-7`, Mythos Preview |
| 4096 | `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-haiku-4-5-20251001` |

An id not in the table gets 4096 (the largest, so a prompt below it is never assumed cached).
Verified live (2026-11-28, `POST /v1/messages`, `cache_control` on the system block): `claude-haiku-5-5`
no write at 496 input tokens, a 530-token write at the next size; `claude-opus-5-5` none at 485,
write 518; `claude-sonnet-5-5` none at 507, write 542 (all consistent with 512);
`claude-haiku-4-5-20251001` none at 992, write 4100. The `1h` tier on `claude-haiku-5-5`: write
`cache_creation.ephemeral_1h_input_tokens` 1402, a second request `cache_read_input_tokens` 1402.

**No vendor returns an expiry.** Ark's `expire_at` is a request parameter (and unused by us);
everything else reports only how many tokens were read or written (some split by TTL tier). So the
kernel derives expiry itself (§9.3).

Idle compaction (phase 2) therefore applies only to requests with a lifetime of 30 minutes or
more: **Anthropic** with the `1h` tier, **OpenAI GPT-5.6+** with its default `30m` tier (a
minimum), and **Bailian Qwen4** with `1h` (works on the native `multimodal-generation` endpoint,
verified). With `promptCache.longTtl` off (the default), Anthropic and Bailian send their 5-minute
defaults and do not qualify; OpenAI 5.6+ qualifies by default. Earlier OpenAI models default to
`in_memory` (about 5–10 minutes) or `24h` retention that is "often about 30 minutes" with no
guarantee, and do not qualify. DeepSeek, Bailian implicit and Ark implicit have no lifetime to time
against (the openai-compatible `qwen` dialect is an explicit 5-minute cache and does not qualify); Ark explicit is Responses-only. All of them still benefit from the in-context summary
(§9.4) whenever their cache happens to hit.


### 9.2 Contract changes (model-provider@2, public SDK API)

In `packages/plugin-sdk/src/model.ts`. Before 0.1.0, changed directly, no compatibility layer
(AGENTS.md "Before 0.1.0").

- **Per-model cache declaration** replaces `ModelInfo.capabilities.caching: boolean`:

  ```ts
  cache?: {
    /** explicit: the plugin places breakpoints and the lifetime is known; implicit: the service
     *  caches on its own (best-effort unless it declares a lifetime floor); none: no caching. */
    mechanism: "explicit" | "implicit" | "none";
    /** Lifetimes a request can choose, in seconds ([300, 3600] Anthropic / Qwen4, [1800, 43200]
     *  OpenAI 5.6+, [300] Bailian); empty when the service decides alone. */
    ttlOptions: number[];
    /** The lifetime a request that names none gets (OpenAI 5.6+: 1800). */
    defaultTtl?: number;
    /** OpenAI: the lifetime is a floor, entries may live longer; Anthropic / Bailian: exact. */
    ttlIsMinimum: boolean;
    /** A read restarts the lifetime (Anthropic, Bailian, OpenAI 30m; not OpenAI 12h). */
    refreshOnHit: boolean;
    /** When the lifetime starts counting; Anthropic: the request's start. */
    ttlClock: "request_start" | "unknown";
    /** Below this many prompt tokens nothing is cached. */
    minTokens?: number;
    /** A hit on an unchanged prefix within the lifetime is expected, not best-effort. */
    guaranteed: boolean;
  };
  ```

  Absent or `mechanism: "none"` = no caching. A model qualifies for idle compaction only with
  `guaranteed: true` (explicit, or implicit with a declared floor such as OpenAI 5.6+) and a
  lifetime ≥ 30 min in use. What the kernel used `caching` for today reads `mechanism !== "none"`.
- **Request-level TTL**: `ModelRequest.cacheTtl?: number` (seconds, one of the model's
  `ttlOptions`; a plugin of a model without options ignores it; an unknown value is a kernel
  request-building error, never sent). The plugin maps it to the vendor's field
  (`cache_control.ttl`, `prompt_cache_options.ttl`). The kernel sets it from `promptCache.longTtl`
  (§6.1): off → absent (the model's default); on → the smallest option ≥ 1800 s, if any. Recorded
  in `model_call.request` (a transport option, not model-visible content: no `DriftReason`; a
  replay may send it unchanged).
- **Per-TTL write breakdown**: `ModelUsage.cacheWriteByTtl?: { ttl: number; tokens: number }[]`
  (optional; sums to `cacheWriteTokens`), from `ephemeral_5m/1h_input_tokens`,
  `ttl_30m/12h_tokens`, Qwen4's split. Usage and cost reports price writes by tier with it.
- There is **no** "actual TTL / expiry" usage field: no vendor reports one (§9.3).

Public API: `pnpm gen:sdk-api` plus a changeset bumping `@capybara-hq/plugin-sdk` (`check:sdk-api`,
`check:api-changeset`). The conformance suite checks the declaration (positive integer TTLs,
`defaultTtl` in `ttlOptions` when options exist, `none` with no options) and that a reported
`cacheWriteByTtl` sums to `cacheWriteTokens`.

### 9.3 Deriving the expiry

Per conversation, the kernel derives from the log the **last request that read or wrote the
cache**: the latest `model_call` whose `usage` has `cacheReadTokens + cacheWriteTokens > 0`, on a
model whose declaration is `guaranteed`. Its lifetime `L` is the recorded `cacheTtl`, else the
model's `defaultTtl`; its start `t0` is the attempt's start (`model_call` gains an optional
`startedAt` if its event time is not the start).

- `refreshOnHit: true`: `expiresAt = t0 + L` from that last request (Anthropic counts from the
  request's start, `ttlClock: "request_start"`; with `"unknown"` the kernel takes the request's end
  as `t0`, the later and safer reading only if the vendor counts from the end, and keeps the margin).
- `refreshOnHit: false` (OpenAI 12h): `expiresAt = t0 + L` from the request that **wrote** the
  entry (the latest with `cacheWriteTokens > 0`), not the last read.
- `ttlIsMinimum: true`: `expiresAt` is a lower bound, so firing before it is safe.
- Fire time: `t0 + 0.9 × L`, never later than `expiresAt − 30 s`.

Nothing is stored outside the log; the derivation reads recorded fields only, at arm time from the
run's own calls, at fire time from the log.

### 9.4 The in-context summary (reusing the cached prefix)

The request:

- the conversation's **last request exactly as recorded**: the same `system` (blocks and `cache`
  flags), the same `tools`, the same history, rebuilt through the eval zero-drift path
  (`reconstructInputs` / `assembleModelRequest`, the technique of
  `conversations/prompt-suggestion-request.ts`);
- then that request's assistant reply, then **one appended user message** with the summary
  instruction (the Claude Code template, worded for "the conversation above");
- `toolChoice: "none"` (the tools stay declared because removing them changes the prefix); a tool
  call in the reply fails the attempt;
- the same model and the same `cacheTtl` as the last request (a different tier can split the entry:
  Anthropic requires 1 h entries before 5 min ones).

Only the appended message is new, so the vendor serves everything before it from the cache while
the cache is alive.

When it applies: the same model as the last call (a model switch breaks the prefix, Claude Code's
guard too); the rebuild has no drift; it fits (last request + reply + instruction +
`maxOutputTokens` + reserve `<= W`: every sent request already fits `W − O_p − R_p`, compaction spec
§4.3, and the 20k summary cap is usually below `O_p`, so it usually fits unless the last reply is
large). Otherwise inline and manual compactions take the transcript path as today; idle compaction
does not run (§4.3 check 9).

Interaction with chunked compaction (§4.5): they do not combine. Chunking exists because the
material exceeds one request; the in-context request is by construction one request the model
already accepted. A history too large for one request has no single cached prefix to reuse.

Coverage stays the plan's (`coversUpToSeq`, `openingSeqs`): the model sees the kept tail too, and
the instruction marks the last event the summary covers, so the kept turns are not folded into the
summary. If the model cannot be held to the mark, the summary covers everything and the tail is
empty (decided in the phase 1 plan with an eval, Q9: it cannot, so the in-context summary covers
everything; the result closes this section).

Append-only history and replay: the summary request is a side request, not a step; it appends
nothing to the history the model sees and never changes an earlier request's bytes. Its output is
the ordinary `compaction_summary` text, which later requests and replays read; replays never re-run
it. `compaction_summary` gains an optional `method: "transcript" | "in_context"` (not
model-visible, no `DriftReason`). The in-context request sees what the transcript leaves out
(images, plugin context, project root), so summaries may read differently; zero drift is
unaffected because the summary comes from the log. `model.request` fires with purpose `compaction`
as today; usage shows the cache reads, which is how the benefit is measured.

It applies to **every** compaction (inline, manual, idle): a compaction right after a step finds a
warm cache on any vendor that cached the prefix, including best-effort ones such as DeepSeek.

Q9 result (2026-11-28, `in-context-boundary.live.test.ts`): 20 seeded coding conversations
(64k–126k estimated tokens, 8 head facts before the plan's `keepRecentTurns: 4` boundary, 4 tail
facts after it, each with a unique codeword, head fact H1 the constraint "never touch `secrets/`"),
sent as the in-context request with a marked boundary and as the transcript request over the
plan's transcript (the baseline), through raw vendor clients, summary cap 20,000:

| model | tail leakage | head recall (in-context / transcript) | constraint kept (in-context / transcript) |
|---|---|---|---|
| Anthropic `claude-haiku-5-5` | 9/20 | 68.1% / 81.9% | 16/20 / 20/20 |
| OpenAI `gpt-5-nano` | 11/20 | 21.3% / 38.8% | 10/20 / 12/20 |
| DeepSeek `deepseek-flash` | 18/20 | 90.0% / 88.8% | 20/20 / 20/20 |
| Qwen `qwen3.8-flash` | 18/20 | 91.9% / 86.9% | 20/20 / 17/20 |

The rule (`"marked"` only if every model keeps tail leakage ≤ 1/20, head recall ≥ transcript
recall − 0.05 and the constraint in ≥ 19/20) fails on tail leakage for all four models (9 to 18
of 20; Anthropic and OpenAI also miss recall and the constraint). Decision: **`"all"`**: the
in-context summary covers everything up to the compaction point and keeps no verbatim tail. The
transcript path keeps the plan's tail as before.

Quality gate (ruling R8, 2026-11-28): the in-context path runs only for model families whose
in-context summaries passed the quality eval; every other model takes the transcript path. The
checked-in table is `IN_CONTEXT_SUMMARY_MODELS` in `runtime/context/in-context-compaction.ts`
(provider extension name, optional, and a model id pattern, each with its evidence); a compaction
model no entry matches skips with reason `quality_gate`. This table and that one stay in step:

| provider | model | evidence |
|---|---|---|
| `model-fake` | any | scripted test model; summary quality not measured |

### 9.5 Plugin gaps (plugins repository)

Already fixed by capybara-hq/plugins#304 (being merged):

- **bailian**: the history now carries a cache marker (before, only the last cached system block
  did, and because explicit and implicit caching are mutually exclusive per request, the history
  got neither).
- **ark**: the `caching` flag no longer depends on the `deepseek-` id prefix.
- `prompt_cache_key` is sent where the vendor supports it.

Still open, waiting on the phase 1 SDK contract (tracked in the plugins repository):

1. **All model plugins**: declare `ModelInfo.cache` per model and map `ModelRequest.cacheTtl`.
2. **anthropic**: no `1h` option yet (always 5 min); does not read the
   `cache_creation.ephemeral_5m/1h_input_tokens` split (`cacheWriteByTtl`); no per-model minimum
   length declared.
3. **openai**: sends no `prompt_cache_options` / `prompt_cache_retention`; does not read
   `cache_write_tokens_details` (`cacheWriteByTtl`); must declare GPT-5.6+ (numeric id prefix
   `gpt-<major>[.<minor>]` ≥ 5.6, §9.1) as `guaranteed`, `defaultTtl: 1800`, `ttlIsMinimum: true`,
   `minTokens` 1024; send `prompt_cache_options` only for those ids (`gpt-5.5` answers 400).
4. **bailian**: no `1h` option (Qwen4 has one and it works on the native `multimodal-generation`
   endpoint, §9.1: `cache_control.ttl: "1h"` on the marker, or `parameters.prompt_cache_options`,
   never the body's top level, which is silently ignored); does not read Qwen4's TTL split
   (`usage.prompt_tokens_details.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`).
5. **openai-compatible `qwen` dialect**: since plugins#304 an explicit 5-minute cache (markers on the
   last system block and the last message; confirmed live, §9.1), so it declares explicit, `5m` only,
   hit-refreshed, `minTokens` 1024, and is not eligible for idle compaction; it reads
   `cache_creation_input_tokens` correctly. Its `ephemeral_5m` split can feed `cacheWriteByTtl`.
6. DeepSeek and Ark report no cache writes (`cacheWriteTokens` 0): a vendor limit, not a plugin bug.

## 10. Rollout

1. Phase 1: SDK contract and changeset, kernel request TTL and expiry derivation, the in-context
   summary for every compaction, `promptCache.longTtl` (off); the plugins declare and map (§9.5).
   Measure the cache reads of summaries.
2. Phase 2: idle compaction with `idleEnabled` on (Q1). It runs at once for OpenAI 5.6+ models and
   wherever an admin turns on the long tier; the release notes say so and state the long tier's
   price.
3. Read the `IdleCompaction` and `idle_return` logs on prod for two weeks: fire outcomes, preemption
   rate, return rate, summaries' cache reads; adjust the size defaults.

Kernel changes ship in the images: a changeset on `@capybara-hq/capybara` (and the kernel package
as the release process requires); phase 1 adds the `@capybara-hq/plugin-sdk` changeset.

## 11. Tests

Per the test portfolio: unit tests need no database (and join `packages/kernel/test/unit-tests.json`
in the same change), integration tests are one app per file (the default), dual-replica tests join
`packages/kernel/test/container-tests.json`.

Phase 1:

- Unit: expiry derivation (recorded `cacheTtl` over `defaultTtl`, refresh on hit vs from the write,
  `ttlIsMinimum`, `ttlClock`, the margin); `cacheTtl` selection from `longTtl` (smallest option
  ≥ 1800 s, none, OpenAI default); in-context applicability (model switch, drift, fit); the
  in-context request equals the recorded request byte for byte in `system`, `tools` and history,
  with `toolChoice: "none"` and one appended message; `promptCache` settings merge and ranges.
- SDK: conformance checks of the declaration and `cacheWriteByTtl`; `gen:sdk-api` report.
- Integration: an inline compaction after a cached step uses `method: "in_context"` (model-fake
  reporting cache reads), a model switch falls back to the transcript path; `model_call.request`
  records `cacheTtl`; zero-drift `reconstruct.test.ts` cases with `cacheTtl` and an in-context
  summary.

Phase 2:

- Unit: `idleArmDecision` (kind, trigger, outcome, settings, personal preference, `L < 1800`, size
  per the §4.1 table including 128k / 200k never and 1M at 300k); `idleFireDecision` (each check
  and its order, `expired` at `expiresAt − 30 s`, `no_prefix`); the size threshold formula; the new
  settings' defaults, ranges and merge; `PreferencesSchema.idleCompaction`.
- Integration (default project; prefer extending existing files over new ≤ 5-test files):
  - a run on a model-fake declared with a 1 h cache and a large context owes the outbox row (with
    `OUTBOX_DISPATCH_FAILS`: queue, name, job id, data, `org_id`, `run_at = t0 + 0.9 × L`); then
    `drainOutbox` → an idle compact run → `compaction_summary` with `method: "in_context"`, usage
    purpose `compaction`, `model.request` fired, `run_started.compactOrigin: "idle"`, trigger
    account = owner;
  - nothing owed: a 5-minute cache, `longTtl` off on a 5-minute default model, a small context, a
    `schedule` run, a `budget` stop, settings or preference off, a sub-agent or eval conversation;
  - fire-time: obsolete after a message, busy, expired (a late job), model switched, plan empty;
  - preemption: a message during a running idle compact run (model-fake holding the summary call)
    → `run_aborted.reason: "superseded"`, no summary, then the message's run; a queued idle run
    aborted before claim; a manual compact request returns the idle run's id;
  - HTTP: platform and org settings patches with the new fields, `PUT /me/preferences` with
    `idleCompaction`; `platform-parity.test.ts` stays green;
  - replay: the two `reconstruct.test.ts` cases (§8.3); eval planning skips an idle compact run;
  - web: the settings sections, the account preference, the divider variant and the background
    compacting row (`renderRouteWithCache`), i18n keys in zh and en, `check:web-ui`.
- Container (`container-tests.json`, only what one replica cannot show): a duplicated delivery of
  the same idle job on two workers starts one run; a message accepted on replica A preempts the idle
  compact run on replica B.

## 12. Decisions and open questions

Decided by the maintainer (2026-11-27):

- **Core rule:** idle compaction only before the expiry of a cache of at least 30 minutes; no
  fixed-delay mode, no `idleDelayMinutes`; fire at `t0 + 0.9 × L`, at least 30 s before expiry;
  depends on phase 1 (§1, §4, §9).
- **Q1:** `idleEnabled` default on, effective only where the precondition holds (a ≥ 30 min cache
  in use; with `longTtl` off that is OpenAI 5.6+ only).
- **Size:** `idleMinTokens = max(200k, 30% × W)`, as settings with these defaults (§4.1).
- **Arm-time filtering:** the cheap checks run at run end and nothing is owed when they fail;
  fire-time re-checks stay (§4.2, §4.3).
- **Q2** (the fixed delay default): moot under the core rule.
- **Q3:** a new message always preempts an idle compact run (§5.2).
- **Q4:** no per-conversation switch.
- **Q5:** usage split by compaction origin in admin views: later.
- **Q6:** the job runs on `cap-kernel-maintenance`.
- **Q7:** `background_task` / `subagent` wakes arm; `schedule` does not.
- **Q8:** cache declaration with kernel-derived expiry and the in-context summary first (phase 1),
  idle compaction after (phase 2).
- **Q10:** `promptCache.longTtl` default off.
- **Q11:** 5-minute caches never get idle compaction.

Still open (recommended answers):

- **Q9. In-context summary boundary (§9.4). Decided 2026-11-28 by the phase 1 eval (gate G1):
  `"all"`.** Whether the model can be held to "summarize up to the marked point" reliably enough to
  keep the kept tail. It cannot: over 20 seeded conversations the in-context summary named a tail
  fact in 9/20 (Anthropic `claude-haiku-5-5`), 11/20 (OpenAI `gpt-5-nano`), 18/20 (DeepSeek
  `deepseek-flash`) and 18/20 (Qwen `qwen3.8-flash`) conversations against a limit of 1/20; head
  recall in-context / transcript 68.1/81.9%, 21.3/38.8%, 90.0/88.8%, 91.9/86.9%; constraint kept
  16/20, 10/20, 20/20, 20/20 (transcript 20, 12, 20, 17). The in-context summary covers everything
  up to the compaction point and keeps no verbatim tail (table in §9.4).
- **Q12. Unverified vendor facts (§9.1). Closed 2026-11-28 (task P0), with two items left
  unverified.**
  - OpenAI `prompt_cache_options` on Chat Completions: accepted on 5.6+ (usage then has no TTL split),
    rejected with 400 on `gpt-5.5`; our Responses mapping is unaffected.
  - OpenAI 24h `prompt_cache_retention` tier: refresh on a hit and price stay **unverified** (neither
    the guide nor the pricing page states them); earlier models do not qualify regardless.
  - Qwen4 `prompt_cache_options` on the DashScope native endpoint: works, on `multimodal-generation`
    only (`qwen4-max` is not served by `text-generation`), as `parameters.prompt_cache_options` or
    `cache_control.ttl`; usage `prompt_tokens_details.cache_creation.ephemeral_5m/1h_input_tokens`.
  - Explicit Bailian 5-minute cache restarts on a hit: confirmed live (hit at 362 s on an entry read at
    171 s).
  - openai-compatible `qwen` dialect: an explicit 5-minute cache, confirmed on the compatible-mode
    endpoint (second request reads, `cache_creation.ephemeral_5m_input_tokens` reported).
  - DeepSeek: no documented minimum or unit; measured unit 128 tokens, first hit at a 262-token prompt
    (declare `minTokens` 256); no configurable lifetime.
  - Ark: implicit-cache hit prices and the 0.017 CNY / 1M tokens / hour explicit storage price recorded;
    per-model minimums confirmed against the page and one live probe (2048 on
    `deepseek-v4-flash-ga-260731`); the Context API `ttl` is 3600–604800 s, default 86400, reset on use.
  - Anthropic per-model `minTokens` table recorded (§9.1), confirmed live at the 512 boundary.
  - Still unverified: the OpenAI 24h tier's refresh and price; whether a Qwen4 hit renews a 1h entry
    over a full hour (documented, not probed).

## AGENTS.md rules touched

- **Multi-replica discipline:** a new delayed job (`idle-compaction`, id `idle-compact-<runId>`, no
  `:`) owed through the outbox in the run-finish transaction only when the arm checks pass, BullMQ
  as the timer, consumed under `WorkerModule` inside `runJob` (org scope from `orgId`); no
  in-process timer; the expiry is derived from the log, never kept in memory; the idle compact run
  is started under the conversation row lock and excluded from ordinary runs by the run claim;
  preemption uses the existing cross-replica abort channel (§4.2, §5.1, §5.2, §9.3).
- **Runtime and replay:** idle compaction writes an ordinary `compaction_summary`; no new
  model-visible input, no `DriftReason`; `run_started.compactOrigin`, `run_aborted.reason:
  "superseded"`, `compaction_summary.method` and `model_call.request.cacheTtl` are not
  model-visible; the in-context summary is a side request that never changes the history's bytes
  (§8.3, §9.2, §9.4).
- **Model providers:** model-provider@2 replaces `capabilities.caching` with a per-model `cache`
  declaration and gains `ModelRequest.cacheTtl` and `ModelUsage.cacheWriteByTtl`; no expiry field
  (no vendor reports one, the kernel derives it); public SDK API: `gen:sdk-api` plus a changeset
  (§9.2, §9.3).
- **Migrations:** one additive column `runs.compact_origin` (§5.7).
- **Config / settings:** three compaction fields and the `promptCache.longTtl` group (platform
  default, org override) and a personal preference (§6).
- **Platform tool:** no new route; the fields join the shared schemas the existing operations are
  built from (§6.2).
- **Web UI / language:** settings fields, a prompt cache section, an account preference, a divider
  variant, i18n zh / en with 智能体 / 平台 (§6.4).
- **Tests:** new unit and container tests join their checked-in lists in the same change (§11).
