# Compaction model

Status: design, for maintainer review (2026-11-28). Builds on the context compaction design
(`2026-11-14-context-compaction-design.md`, cited as "compaction spec §n"), whose §6 deferred "a
`compaction` model purpose mapping (cheaper summary model)", and on the idle compaction design
(`2026-11-27-idle-compaction-design.md`, cited as "idle spec §n"). Scope: kernel runtime
(compaction, idle compaction), the model purposes, platform and org settings, the web purposes and
settings pages, the Platform tool descriptions. Docs only; no code in this change.

## 1. Why

The transcript summary request (`buildCompactionRequest`, `runtime/context/compaction.ts`) is built
by kernel code alone: the compaction instruction as the system prompt, `tools: []`, and one user
message holding a plain-text transcript of the events (`compactionPlan`). No part of it depends on
the conversation's model: images and documents are already rendered as placeholders
(`[image: "<name>"]`, `[document: "<name>"]`, `renderBlocks`), thinking blocks are dropped, tool
calls and results are text. So **any chat model can write the summary**, and the summary it returns
is stored as text (`compaction_summary.text`) that the conversation's own model then reads.

Today every summary is written by the model whose next request it serves (`prepareCompaction`
resolves `opts.ref ?? input.agent.model`): the conversation's model, or the overflowed rung on the
reactive path. On a large conversation with an expensive model that is the most expensive call the
kernel makes (an 800k transcript at full input price, §8). The in-context summary (idle spec §9.4)
makes it cheap only on the three model lines that passed its quality gate
(`IN_CONTEXT_SUMMARY_MODELS`: `claude-sonnet-*`, `deepseek-flash*`, `qwen4-max*`) and only while the
prompt cache is warm; extending that gate model line by model line needs a quality eval per line,
which is why issue #1002 (gate an OpenAI 5.6+ model) was closed.

Maintainer decision (2026-11-28): add a **compaction model**, a model purpose `compaction`. If an
admin configures it, every summary is written by that model through the transcript path ("如果配置了
优先使用"); if not, nothing changes. A cheap model with a large window (for example `deepseek-flash`,
1M window) makes summaries cheap without per-model in-context evals, because the transcript path's
quality depends only on the summarizing model, and that is one model the admin picks.

Evidence already in the repository: the transcript columns of the idle spec's "all" quality gate
(§9.4, 20 seeded conversations, summary cap 20,000) are exactly a measurement of each model **as a
compaction model**, since the transcript request does not involve the conversation's model:

| model | transcript recall | constraint kept (transcript) |
|---|---|---|
| Anthropic `claude-haiku-5-5` | 81.3% | 20/20 |
| Anthropic `claude-sonnet-5-5` | 73.8% | 20/20 |
| OpenAI `gpt-5-nano` | 19.6% | 8/20 |
| DeepSeek `deepseek-flash` | 87.5% | 20/20 |
| Qwen `qwen3.8-flash` | 90.0% | 20/20 |
| DeepSeek `deepseek-v4-pro` | 80.4% | 20/20 |
| Qwen `qwen4-max` | 97.1% | 20/20 |

Summaries always lose information. The goal is that the important things survive (the users'
requests and constraints, the current work, open tasks), not zero loss; the template, the
acceptance check and the framing after the summary (compaction spec §4.2.1, §4.2.2) are unchanged.

## 2. Goals and non-goals

Goals:

1. One purpose mapping (platform default, org override) moves every summary to one chosen model.
2. Unmapped means today's behaviour, byte for byte.
3. The summary still fits the conversation's model: the conversation side of the plan (tail
   budget, trigger, hard fit guard) never changes; only the summarizer does.
4. Idle compaction works with a compaction model without a warm cache, timed by idle duration.
5. Replay and usage stay truthful: the log says which model wrote each summary; usage is billed to
   that model.

Non-goals:

- A quality gate on the compaction purpose (§12 Q4).
- A second summary algorithm, a different template per model, chunking changes beyond the budget
  inputs.
- A history lookup tool and an absolute trigger cap for 1M windows (§11, future work).
- Per-agent compaction models. The purpose is org-wide like every purpose.

## 3. Chosen approach

**A. The purpose decides the summarizer; the conversation model keeps deciding the plan.**

```
step / compact run
  ├─ conversation model V (opts.ref ?? agent model): estimate, trigger, plan, tail budget, fit guard
  ├─ resolve purpose "compaction" for the org
  │    ├─ configured and usable and eligible (§4.3) ─▶ summarizer C, transcript path (no in-context)
  │    └─ unconfigured / disabled / unavailable / ineligible ─▶ summarizer V, today's rules
  └─ summary call(s) on the summarizer; compaction_summary { …, model } + usage on the summarizer
```

Rejected:

- **B. In-context first, compaction model second** (use the cached in-context request when the
  gate passes and the cache is warm, the compaction model otherwise). The cost of a warm in-context
  summary on a gated model is close to a cheap transcript summary (§8), but it is not what the
  maintainer asked for, it keeps two summarizers live per conversation, and inline compactions do
  not know whether the cache is warm (the kernel derives an expiry only for guaranteed caches, idle
  spec §9.3). Kept as §12 Q2.
- **C. A compaction model per agent** (a field on the agent definition). More knobs, and the
  decision is a deployment cost / data residency decision, which the purposes already model.
- **D. Fall back to the conversation model on any compaction-model failure.** Doubles the cost of
  an outage and hides it; a policy denial must never be routed around. Resolution-time fallback only
  (§4.2); call-time failures fail the compaction as today (§12 Q1).

## 4. The purpose

### 4.1 Declaration

A new entry in `KERNEL_PURPOSES` (`models/purposes.ts`):

```ts
/**
 * The compaction summarizer (compaction model spec); unmapped → the model whose next request the
 * summary serves (the conversation's model, or the overflowed rung on the reactive path).
 */
{ purpose: "compaction", kind: "chat", label: { zh: "摘要压缩", en: "Compaction" } },
```

- `kind: "chat"`, no `requires`: the transcript is text only (§1), so the target needs no vision
  and no documents.
- Placed after `web_fetch` (the conversation-model fallbacks together) in the list order.
- Mapping, override, validation, audit (`model.purpose_mapped`) and the purpose APIs are the
  existing ones; no new route.

### 4.2 Resolution and fallback

Each compaction resolves the purpose once, in `prepareCompaction`, through
`ModelPurposesService.resolve(orgId, "compaction")`. `ModelStepDeps` carries no purposes service, so
the step reaches it through a new optional dep `compactionModel?: CompactionModelPort` (absent =
unmapped, which test stubs and step replays rely on); `RunSteps` provides it, and full-run replays
inherit it through `replayLoopDeps` and resolve C through the billed replay registry (§7.3). The
purpose is resolved only after the trigger passed and a plan exists, so a step that does not compact
pays no extra read; the summarizer is chosen right after the plan and before `hooks.planned`.

| Result | Summarizer |
|---|---|
| mapped, usable in the org | the mapped model C |
| `model.unconfigured`: unmapped, or the effective target disabled on the platform or in the org, its provider off or needing config in the org, gone from the list, of another kind (the existing `resolve` rules) | the conversation model V, today's rules (in-context where the gate allows, else transcript) |
| `ProviderListError` passes `resolve`, then `registry.resolve` of C fails | V, logged at `warn` (`context=Compaction`, `reason: "compaction_model_unavailable"`) |
| C resolves but is ineligible for this compaction (§4.3) | V, logged at `debug` (`reason: "compaction_model_small"`) |

Rationale for falling back to V instead of skipping: an automatic compaction runs because the
conversation is near or over its line; V is resolvable (the step is about to call it), and a summary
written by V is better than the trim the hard guard would apply. This is the rule `title` and
`web_fetch` already follow (`chatTarget` with a fallback).

The idle compact run is the exception (§6.3): it never falls back to V, because a full-price
background summary on V is what the idle core rule forbids.

A configured, usable, eligible C always wins over the in-context summary (§12 Q2): the in-context
attempt skips with `InContextFallback` `"compaction_model"`. Unmapped is today's behaviour byte for
byte: `params: {}`, `summaryCap = min(setting, V max)`, the in-context path where the gate allows.

### 4.3 Eligibility: a window too small to be useful

C is used only if its window leaves a useful chunk:
`compactionChunkSize(compactionInputBudget(Wc, Cmax, R), Cmax) ≥ MIN_COMPACTION_MODEL_CHUNK_TOKENS`
(32,000), with `Cmax` from §5.1. Below it, a long transcript would need dozens of rolling calls on C,
each re-summarizing the running summary (drift and latency the cheap price does not buy back), and
the degenerate-budget rule of compaction spec §4.5 (one call over the whole transcript) would
overflow C. Every model a deployment is likely to map (128k windows and up) passes: a 128k window
with the defaults leaves about 128,000 − 20,000 − 8,000 − 10,000 − overhead ≈ 88k.

With this floor the chunk loop's "the running summary leaves too little room for a chunk" failure
cannot occur on C under the estimator's own counts (the worst held summary is `Cmax` ≤ 32,000 by the
settings range, so a later chunk keeps at least 32,000 − 16,000 = 16,000 tokens); an estimate
mismatch keeps today's failure path (`compaction_failed`, no switch mid-compaction).

### 4.4 Which compactions use it

All of them when C is configured, usable and eligible (maintainer intent):

| Compaction | Today | With a compaction model |
|---|---|---|
| Proactive (step boundary, trigger / hard line) | V; in-context if gated and settled, else transcript | C, transcript; the in-context attempt skips with reason `compaction_model` |
| Reactive (`model.context_overflow`, `force`, `transcriptOnly`) | the overflowed rung's model, transcript | C, transcript; the plan and cap still use the rung's window (§5) |
| Hard guard's forced compaction (compaction spec §4.3 point 5) | the rung's model | C, transcript |
| Manual compact run (`manual`) | V, transcript, the #990 plan | C, transcript, the #990 plan unchanged |
| Idle compact run | V, in-context only (cache-timed) | C, transcript, timed by idle duration (§6) |
| Sub-agent conversations, eval full-run replays | as the chat path | the same rule: the org's mapping applies (an eval replay compacts like production would) |

`InContextFallback` gains `"compaction_model"` (logged as the other skips). The plan
(`compactionPlan`, its `keepRecentTurns` or manual rule, `openingSeqs` / `manualOpeningSeqs`) is the
transcript path's, unchanged.

### 4.5 Parameters

The summary call sends the mapping's params, sanitized against C's declarations
(`sanitizeParams(info.parameters, target.params)`, as `ModelPurposesService.chat` does). No
`paramDefaults`: the measured transcript recall (§1) was taken with the vendors' defaults, and
thinking may help a summarizer; an admin who wants it off sets `thinking: "off"` in the mapping.
The fallback path (V) keeps today's `params: {}`. `buildCompactionRequest` hard-codes `params: {}`
today; it gains `opts: { retry?; params? }` with `params` defaulting to `{}`.

## 5. Chunking and the summary cap

Two models now meet in one compaction: V, the model whose next request carries the summary, and the
summarizer S (C when used, else V).

### 5.1 What comes from which model

| Quantity | From | Why |
|---|---|---|
| Request estimate, calibration, trigger, hard line, backoff | V | they are about V's next request (compaction spec §4.1) |
| Planning bounds `O_p`, `R_p`, tail budget, manual tail budget | V | the kept tail must fit V's window (§4.2) |
| Hard fit guard after compaction | V | unchanged (§4.3) |
| Summary cap `Cmax` | `min(S_setting, maxOut(C), maxOut(V))` | see below |
| Chunk budget `B = Wc − Cmax − R`, chunk size, overhead | C (the summarizer's window) | the call's input must fit the model receiving it (§4.5) |
| `streamIdleTimeoutMs` | C | the stream being watched is C's |
| Acceptance (`acceptSummary`), `savedTokens` | unchanged | text-only measures |

**The cap.** Today `summaryCap = min(maxOutputTokens setting, V.maxOutputTokens)`. With C the
summary must still fit V: summary + kept tail + system + tools + V's output + reserve within V's
window. The tail budget and the hard guard were tuned against today's cap, and the guard protects
the summary text from truncation, so the summary must not grow beyond what V would have written:
`Cmax = min(setting, C.maxOutputTokens, V.maxOutputTokens)`. Adding C's term only narrows the cap;
keeping V's term means a large-output summarizer (`deepseek-flash` declares 393,216) never writes a
longer summary than today's for a small-window conversation. On the reactive path V is the
overflowed rung.

### 5.2 Number of chunks and the running summary

Unchanged algorithm (compaction spec §4.5), different inputs: one call when the transcript estimate
is at most the base chunk size of C's budget; otherwise sequential chunks with the running summary
(`[Earlier summary]\n<summary>`) before each later chunk, each call's chunk shrunk to the running
summary's real estimate, the last call's text accepted against the full transcript, one `usage`
event per call keyed by chunk, the cut-off retry per call (§4.2.1), and `[chunk split]` for a single
line larger than the chunk (so one oversized event never fails, it is split at a character
boundary). The chunk count is `≈ ceil(transcript / chunk)`: with `deepseek-flash` (1M window) and
the defaults, any transcript up to about 1,000,000 tokens is one call; a 128k summarizer takes about
one call per 88k.

A window that cannot hold the running summary plus a chunk is excluded up front by §4.3, so there
is no truncation rule and no mid-compaction switch: if a chunk call fails anyway, the compaction
writes one `compaction_failed` naming the chunk, as today.

### 5.3 Media and documents

Nothing changes: the transcript never carries media bytes (placeholders by name), so a summarizer
without vision or document support reads the same transcript every summarizer reads today. The
in-context request saw images; a conversation whose summaries came from the in-context path on a
gated model will summarize images by name only once a compaction model is configured. Text an
earlier step derived from an image (the `vision` purpose's description in a tool result, an
assistant reply describing it) is in the transcript and survives.

## 6. Idle compaction with a compaction model

### 6.1 Two modes

| | Cache mode (idle spec phase 2, unchanged) | Compaction-model mode (new) |
|---|---|---|
| When | no compaction model usable and eligible for the org at arm time | the `compaction` purpose resolves to a usable **and eligible** C (§4.3) at arm time (behaviour, decided in the plan review) |
| Request | in-context, V, cached prefix | transcript, C |
| Gate table, settled point, fit-plan skip | required | not applicable |
| Timing | `min(t0 + 0.9 × L, expiresAt − 30 s)`, `L ≥ 30 min` | `run end + idleDelayMinutes` |
| Cache warm check (fire check 5) | required | not applicable |
| Size threshold | `idleMinTokens(W)` | the same, `W` = V's window |

The idle core rule ("only to beat a cache expiry", idle spec §1) existed because a background
summary on V without a warm cache costs full price and is often wasted. With a cheap C that
argument changes: the background summary costs a few cents on a large context (§8), and it saves
the returning person both the wait and a cold full-price re-read of the large context by V (on an
expensive V, that re-read alone costs more than the summary). So compaction-model mode is timed by
idle duration. Without a compaction model, phase 2 behaviour is unchanged.

Eligibility is decided per compaction (§4.3), and an ineligible C makes every inline compaction use
V. So arm time asks the same question the compaction asks: compaction-model mode only if
`chooseSummarizer` returns C against V = the last call's model and the effective settings;
otherwise cache mode. An ineligible C then never owes jobs that could only end `no_model`
(behaviour, decided in the plan review).

### 6.2 Arming (idle spec §4.2)

`idleArmDecision` gains a `mode` fact. The arm path (`IdleArm.decideOrSkip`, outside any
transaction, errors swallowed) resolves the purpose after the settings and preference checks:

- Checks 1–3 (kind and trigger with automation lineage, outcome, settings and personal
  preference) and 5 (size) are unchanged in both modes. Size compares the last call's actual input
  plus output with `idleMinTokens(W)`, `W` the context window of the last call's model (V), as now:
  the threshold measures V's next request, which is what the compaction relieves, and the inline
  trigger the idle run preempts is relative to V's window.
- Compaction-model mode skips check 4 (cache lifetime) and check 6 (quality gate, settled point,
  fit plan): none of them bears on a transcript summary.
- Owed job: the same outbox row (queue `cap-kernel-maintenance`, name `idle-compaction`, job id
  `idle-compact-<runId>`, `orgId` set), `runAt = now + idleDelayMinutes × 60_000`, with `now` taken
  in `IdleArm.decide` (the arm decision runs in the worker just before `RunFinish.finish`, so
  `finished_at` is not known yet; the difference is milliseconds), data
  `{ orgId, conversationId, runId, armedSeq, mode: "compaction_model" }` (no `cacheCallSeq`,
  `expiresAt`); cache mode writes `mode: "cache"` with its existing fields. `IdleCompactionIntent`
  becomes a union on `mode`. The `OUTBOX_JOBS` `idempotent` sentence is unchanged (the job still
  starts at most one idle compact run under the row lock).

### 6.3 Fire time (idle spec §4.3) and the run

`idleFireDecision` takes the job's `mode`; the consumer reads `data.mode ?? "cache"` (jobs owed by
the previous release may still be in the outbox or queue across a deploy; every new row carries
`mode`):

- Checks 1–4 and 6 unchanged (gone, obsolete, busy, disabled, backoff).
- Check 5 (`expired`) only in cache mode. A compaction-model job that fires late (worker backlog,
  outage) still runs: lateness costs nothing here.
- Check 7 (`no_model`) in compaction-model mode: the effective definition's model resolves for the
  org (its window sizes the plan) **and** `chooseSummarizer` returns C. There is no armed call to
  compare with (cache mode compares the effective model with the armed call), so a model switch
  since arming does not end the job: the probe sizes against the new V. If an admin cleared or
  disabled C since arming, the job ends `no_model`: it never falls back to V, and never switches to
  cache mode (no expiry was derived).
- A cache-mode job that finds a compaction model configured at fire time (C wins over in-context,
  §4.2) ends `no_prefix` and writes nothing: the probe reports `inContext: false`, and no
  background call the job was not armed for is made. The next finished run arms in
  compaction-model mode (behaviour, decided in the plan review).
- Check 8 (`small`, size and the 20k growth) via `probeIdle`, which runs `prepareCompaction` in
  the job's mode.
- Check 9 (`no_prefix`) only in cache mode.

The run: `RunQueue.startIdleCompaction(conversationId, armedSeq, mode)` otherwise unchanged (row
lock, `compact_origin = 'idle'`, owner as trigger account, preemption by any input, no queue pause).
The run worker knows only the row, not the job, so the mode is stored on it: `runs.idle_mode`
(§7.1), which the worker passes to `CompactionService.force`; a run never switches modes between
arm, fire and run. `CompactOptions.requireInContext` is replaced by
`idle: "cache" | "compaction_model"`: `cache` keeps today's in-context-or-nothing;
`compaction_model` requires C (if it no longer resolves when the run starts, the run writes
nothing and finishes `completed`) and summarizes the transcript with the automatic plan
(`keepRecentTurns`, the full tail budget; never `manual`). Progress shows from the plan on, as for
any transcript compaction; because the summarizer is chosen right after the plan and before
`hooks.planned` (§4.2), a run whose C is gone ends before any progress row. Everything else of idle spec §5 (preemption, abort, shutdown, the
quiet UI, no push, the conversation list staying still) applies to both modes.

### 6.4 The delay setting

A new compaction field, `idleDelayMinutes`, default **30**, range 5–1440, used only in
compaction-model mode. Why 30: the idle spec's own value measure (`idle_return`, §7) defines a return
after idle as more than 30 minutes; a person who comes back sooner usually continues a train of
thought where an inline compaction (or none) is fine, and a summary written at 5 minutes would often
be preempted or wasted. Firing at 30 minutes targets exactly the returns the metric counts. A
deployment on a very cheap summarizer may lower it; an org that wants fewer background calls may
raise it. `idleEnabled: false`, `enabled: false` or the personal opt-out still turn both modes off.

This reverses the idle spec's "no delay field" (§6.1, maintainer decision Q2) for
compaction-model mode only; the reason above is why the earlier ruling does not apply to a cheap
transcript summarizer.

## 7. Event log, usage, replay

### 7.1 Events

- `compaction_summary` gains an optional `model: { provider: string; model: string }`: the
  configured ref of the model that wrote the summary (C, or V on the fallback path; the last
  chunk's, which is the same model for every chunk of one compaction). Written on every new summary
  (so the log is self-describing whether or not a compaction model is configured); absent on
  summaries written before it. `method` stays `"transcript" | "in_context"`; a compaction-model
  summary is always `"transcript"`.
- `compaction_failed` gains the same optional `model` (the model whose call failed or was denied;
  absent when no call was sent, such as `the model is unavailable`).
- Idle job data gains `mode` (§6.2); `run_started.compactOrigin` is unchanged. Migration 0199 adds
  `runs.idle_mode text NULL CHECK (idle_mode IN ('cache', 'compaction_model'))`, written by
  `startIdleCompaction` and read by the run worker (§6.3); `runs` has no `org_id`, so no RLS policy.

All additive; old logs parse. None of these fields is model-visible: request building reads
`compaction_summary.text`, `openingSeqs` and `method` (for the framing sentence, compaction spec
§4.2.2), never `model`.

### 7.2 Usage and cost

The compaction's `usage` events already carry the call's `provider` / `model` and `purpose:
"compaction"` (`usageEvents` in `runCompaction`); they now name C, so the `model_usage` rows and the
`usage.report` deliveries derived from them bill C. Step consumers keep skipping them by purpose
(calibration reads only step usage, so C's token counts never calibrate V's estimates). A sub-agent's
budget check after a compaction (`budgetUsedUpAfterCompaction`) reads the recorded usage as today,
which now holds C's tokens.

### 7.3 Replay and zero drift

- The request V receives after a compaction has the same shape as today's transcript-path
  compaction: the summary text in the summary's user message, the re-rendered openers, the framing
  paragraph (the transcript variant). Only the summary's wording differs, and that comes from the
  log. **No new model-visible input, no `DriftReason`.**
- A proactive compaction that would have been in-context becomes a transcript compaction: the
  framing sentence for kept messages is the transcript variant, derived from the logged `method`,
  as for any transcript summary.
- Reconstruction and step replay read the logged summary; they never re-run it (compaction spec
  §4.9). Full-run replay runs compaction live with the org's mapping at replay time (C if mapped),
  counted as real usage, as today.
- Tests: `reconstruct.test.ts` cases for a summary written by a compaction model (proactive, and a
  chunked one on a small-window C), and for an idle compaction in compaction-model mode followed by
  a message run; run the zero-drift fixtures before and after (replay-evals skill).

## 8. Hooks, policy, data residency

- `model.request` fires for every compaction-model call with the existing compaction fields
  (`purpose: "compaction"`, `step`, `attempt`, and `provider` / `model` = C's ref), per chunk and
  per cut-off retry, as today; `model.response` observes likewise. No hook payload change.
- Policy hooks fail closed: a denial writes `compaction_failed` (reason names the plugin, raw detail
  in the audit row) and the compaction ends. **A denial is never a reason to fall back to V**: the
  policy saw C's request and refused it; retrying the same transcript on another model would route
  around it.
- Data residency: with a compaction model, the whole transcript of every compacted conversation is
  sent to C's provider, which may differ from the conversation model's provider. The provider is
  chosen by the super admin (platform default) or the org admin (override), never by members; the
  purposes page hint says so. An org that must keep summaries on the conversation's own provider
  while a platform default exists disables the default's model (or its provider) in the org: the
  effective target is then unconfigured there and summaries fall back to V (§4.2). An explicit
  "use the conversation's model" override is §12 Q3.

## 9. Settings, UI, Platform tool

### 9.1 Settings

- `COMPACTION_FIELDS` gains `idleDelayMinutes: z.number().int().min(5).max(1440)` (default 30 in
  `COMPACTION_SETTINGS`), merged field by field by `effectiveCompactionSettings` and the platform
  patch merge (`identity/settings.ts`), `null` clears an org override, like every compaction field.
- No other new setting: the compaction model itself is a purpose mapping, not a setting.

### 9.2 Web

- **Model purposes** (the admin models page and the org models page, `PurposeEditor`): the new
  purpose appears with its kernel label (「摘要压缩」 / "Compaction") and a hint key
  `hint.compaction` (zh / en): 「未设置时由会话自己的模型写摘要。设置后，自动、手动和空闲压缩的摘要都由这个模型按对话记录写成，对话记录会发给这个模型的服务商。建议选上下文窗口大、价格低、摘要质量经过验证的模型。」 / "When not set, the conversation's own model writes
  summaries. When set, this model writes every summary (automatic, manual and idle) from the
  conversation's transcript, which is sent to this model's provider. Pick a model with a large
  window, a low price and a tested summary quality." The loading shape in `admin/models/view.tsx`
  lists the kernel purposes and gains `compaction` (ten).
- **Compaction settings section** (platform and org settings pages): `idleDelayMinutes`
  「空闲多久后压缩（分钟）」 / "Compact after idle for (minutes)", help 「只在配置了摘要压缩模型时使用：
  上次回复结束这么久后在后台压缩（默认 30）。」 / "Used only when a compaction model is set: compact in
  the background this long after the last reply (default 30)." Disabled while `idleEnabled` is off.
  The `idleEnabled` label and hint become mode-neutral: 「空闲时在后台压缩」 / "Compact idle
  conversations in the background", hint covering both modes (with a compaction model: after the
  idle delay; without one: before a cache of at least 30 minutes expires).
- Conversation page: nothing new (the idle divider and compacting row are the existing ones).
- Design components only (`check:web-ui`); zh copy says 智能体 / 平台 (`check:i18n`).

### 9.3 Platform tool parity

- No new route. The purpose is data served by the existing operations (`models.purposes`,
  `models.set-purpose`, `models.purpose-availability`, `models.platform-purposes`,
  `models.set-platform-purpose`); `platform-parity.test.ts` covers them through the shared schemas.
- `idleDelayMinutes` joins `COMPACTION_SETTINGS` / `COMPACTION_SETTINGS_PATCH`, which the existing
  `org-settings.update` operation is built from; its description, which enumerates the compaction
  fields, gains `idleDelayMinutes? (5 to 1440; minutes after a run before an idle compaction when a
  compaction model is set)` and the `idleEnabled` wording of §9.2. `admin.update-settings` keeps its
  `compaction` omit (console-only, idle spec D2). `pnpm check:platform-ops` stays green; no new
  exclusion.

## 10. Cost (approximate)

An 800k-token conversation (about 780k tokens of transcript after the system prompt, tools and kept
tail), one summary of about 15k output tokens (analysis plus summary; up to 30k with a thinking
summarizer). Prices per 1M tokens, **approximate**: Anthropic list prices from the claude-api skill's
model table (cached 2026-11-03: Sonnet 5.5 $2 input / $10 output / $0.10 cache read, 5-minute cache
write 1.25× input; Opus 5.5 $4 / $20 / $0.20); DeepSeek from its pricing page (read 2026-11-28:
`deepseek-flash` input $0.30 miss / $0.006 hit, output $1.20 at peak; off-peak half). Verify before
quoting.

| Case | Summary cost | Notes |
|---|---|---|
| (a) conversation model on the transcript: Sonnet 5.5 | ≈ $1.71 (780k × $2 + 15k × $10) | one call (1M window); Opus 5.5 ≈ $3.42 |
| (b) conversation model in context, cache warm: Sonnet 5.5 | ≈ $0.24 (800k × $0.10 + ~3k new input + 15k output) | only on gated lines and only while the cache lives; cold it re-reads and re-writes the prefix: ≈ $2.15 |
| (c) `deepseek-flash` as compaction model, transcript | ≈ $0.25 at peak (780k × $0.30 + 15–30k × $1.20), ≈ $0.13 off-peak | one call (1M window); no cache needed; any conversation model |
| (d) for reference: `deepseek-flash` as the conversation model, in context, warm | ≈ $0.02 | the cheapest case, but only for conversations already on that model |

What follows the compaction is the same in every case: V's next request carries the summary and the
tail (a cache write on a caching vendor). A compaction model also removes the variance of (b): the
cost no longer depends on whether the person returned within the cache's lifetime. In compaction-
model idle mode, a background summary on a conversation nobody returns to costs (c) once, bounded by
the size threshold (only contexts of at least `idleMinTokens(W)`).

## 11. 1M windows: future work

The maintainer raised two concerns for very large windows. Both are out of this change's scope:

- **Compact earlier on very large windows.** With `threshold` 0.8, a 1M conversation first compacts
  near 800k, so every step before that re-reads hundreds of thousands of tokens, and the summary of
  800k tokens loses more than a summary of 300k would. A sketch: an absolute ceiling setting
  (`triggerMaxTokens`, trigger at `min(threshold × W, W − O − R, triggerMaxTokens)`), off by default.
  Small in code (one term in `shouldCompact`), but it changes compaction frequency, cost and quality
  for every 1M model and needs its own evaluation of summary quality at the two sizes; a separate
  spec.
- **A tool to look up the original events** a summary covers (by seq range or search), so the model
  can recover a detail the summary lost. It is a new model-visible tool (tool set change, request
  shape, replay of its results, privacy of the covered events, access rules for sub-agents), so it
  needs its own design.

## 12. Decisions

Decided as recommended during design review (2026-11-28).

- **Q1. No call-time retry on the conversation model.** Resolution-time fallback (§4.2) covers a
  removed, disabled or unlisted model; a failed C call (provider error, timeout, cut off twice, a
  policy denial) writes `compaction_failed` and its backoff as today and never retries on V. A policy
  denial is never routed around. The hard guard and the reactive path still protect the step, and an
  outage of C shows in the logs instead of silently doubling cost. Revisit if prod logs show C
  outages causing trims.
- **Q2. A configured compaction model always wins over in-context.** "Configured means preferred";
  (b) and (c) in §10 cost about the same, and a single summarizer per org is easier to reason about
  and to evaluate.
- **Q3. No explicit org "use the conversation's model" override.** An org disables the default's
  model or provider in the org instead (§8); the effective target is then unconfigured there.
- **Q4. No hard quality gate on the purpose.** The admin chooses deliberately; the purposes hint
  asks for a tested model, and the release notes list the measured transcript recall (§1), naming
  `gpt-5-nano` (19.6%) as the risk.
- **Q5. `idleDelayMinutes` defaults to 30** (§6.4).

## 13. Tests

Per the test portfolio (unit tests join `packages/kernel/test/unit-tests.json`, container tests
`container-tests.json`, integration is the default):

- Unit: the summary cap `min(setting, C max, V max)`; eligibility (§4.3) at the floor; chunk budget
  from C's window and plan from V's; `idleArmDecision` and `idleFireDecision` in compaction-model
  mode (no cache checks, `runAt` from the delay, `no_model` when C is gone, no `expired`);
  `idleDelayMinutes` default, range and merge; the in-context skip `compaction_model`.
- Integration (model-fake, two fake models with different windows): a proactive compaction with
  the purpose mapped writes `compaction_summary { method: "transcript", model: C }` and usage on C;
  unmapped, disabled in the org, and ineligible C fall back to V; a reactive overflow on a fallback
  rung plans against the rung and summarizes on C; a manual compact run keeps the #990 plan on C; a
  policy hook denying C's request writes `compaction_failed` and sends nothing to V; a chunked
  compaction on a small-window C; idle compaction-model mode end to end (`OUTBOX_DISPATCH_FAILS`
  row with `mode` and `runAt`, then `drainOutbox` → idle run → summary on C), and a job whose
  purpose was cleared ends `no_model`; HTTP: settings patches with `idleDelayMinutes`, the purpose
  listed and settable; `platform-parity.test.ts` green.
- Replay: the `reconstruct.test.ts` cases of §7.3.
- Web: the purpose row and hint, the settings field, i18n zh / en (`renderRouteWithCache`).
- Live (optional, `CAPYBARA_TEST_*` env): one transcript compaction on `deepseek-flash` through the
  real provider plugin.

## AGENTS.md rules touched

- **Model providers:** a new kernel purpose `compaction` (kind `chat`), unmapped → the conversation's
  model; a disabled target counts as unconfigured (existing rule) and falls back; calls made for an
  org carry the org's mapping and params; no change to model-provider@2 (§4).
- **Runtime and replay:** `compaction_summary.model` and `compaction_failed.model` are additive,
  not model-visible; the request after compaction keeps its shape; no new model-visible input, no
  `DriftReason`; zero-drift cases added (§7).
- **Extensions (hooks):** `model.request` fires for every compaction-model call; policy hooks fail
  closed and a denial never falls back to another model (§8).
- **Multi-replica discipline:** idle compaction-model mode reuses the outbox row, the deterministic
  job id `idle-compact-<runId>` (no `:`), `runJob` under `WorkerModule`, the row lock and the
  cross-replica preemption; no timer, no in-process state (§6).
- **Config / settings:** one compaction field `idleDelayMinutes` (platform default, org override)
  (§9.1).
- **Platform tool:** no new route; the field joins the shared schemas, the operation descriptions
  that enumerate compaction fields are updated (§9.3).
- **Web UI / language:** a purpose hint, a settings field, mode-neutral idle copy, i18n zh / en with
  平台 / 智能体 (§9.2).
