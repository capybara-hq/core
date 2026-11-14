# Context compaction redesign

Status: draft for review, 2026-11-14. Scope: kernel runtime, conversation events, SSE, web UI, platform and org settings.

## 1. Problem

Conversation history can reach the model's context limit before compaction runs, and the provider then rejects the whole step (`400 context length`). Compaction can also fail for its own reasons (the summary request itself is too large, a short summary, a provider error), and there is no user-visible progress or manual control.

Current behavior (`packages/kernel/src/runtime/context/compaction.ts`, `runtime/model-call.ts`):

- Trigger: `estimate >= model.contextWindow * threshold` (default 0.8) on the **input estimate only**; no output reserve, no hard fit guard.
- Plan: keep the last `keepRecentTurns` (default 4) user turns verbatim; summarize everything older; merge the previous summary. One summary request, `maxOutputTokens: 4096`.
- Failure: `compaction_failed` with exponential backoff in user turns; the step continues uncompacted.
- Config: `KernelConfigSchema.runtime.compactionThreshold` / `keepRecentTurns` (env/file/Nacos, restart, deployment-wide; no org level).
- No progress, no manual trigger. The web only renders the completed divider.

## 2. Goals

1. **No context-length error.** Any history must fit before a request is sent; the provider must never reject us for context length.
2. **Sensible timing.** Compact early enough to keep the output reserve and a safety buffer, while keeping as much recent context as possible.
3. **Visible progress.** A person can see that compaction is running; a real `i/N` only where chunking actually happens.
4. **Manual control.** A UI action and `/compact` can compact on demand.
5. **Platform/org settings.** Platform defaults and org overrides for the compaction line, with bounds; the hard guarantee is not configurable.

Non-goals: background precomputation of the summary; a compaction model purpose mapping; a real percentage in the single-request path.

Anti-goals: fake progress; an org setting that can disable the hard guard; changing the event-log-as-truth/replay contract; introducing a second compaction algorithm for normal-sized histories.

## 3. Chosen approach

**A. Layered guarantee: proactive trigger + single summary + hard fit guard + chunked fallback + reactive retry.**

```
estimate → trigger? → single summary → still over? → chunked summary (i/N)
         → still over? → deterministic fit trim → send
         → provider says context_overflow → media exclude / compact (force) / trim → retry, bounded
```

Rejected:

- **B. Always chunked summaries.** Real progress and a bounded request, but more model calls, cost, latency and summary drift; Claude Code does not do this.
- **C. Reactive + settings only.** Smallest change, but it cannot guarantee goal 1 when the compaction request itself is too large or the kept tail is huge.

Compaction stays synchronous at the step boundary (the user explicitly chose not to shorten it) and stays inline in the run worker; no precompute, no queue redesign.

## 4. Design

### 4.1 Effective window and trigger

Let `W = model.contextWindow`, `O = min(agent maxOutputTokens, model.maxOutputTokens)`, `R = reserveTokens` (default 8000).

- Trigger when `calibratedEstimate >= min(threshold * W, W - O - R)`.
- Always trigger when `calibratedEstimate + O > W` (hard line), regardless of backoff.
- `threshold` is a preference, not a guarantee: a late threshold cannot cause an overflow because of 4.3.
- Backoff (2^attempt user turns) remains for proactive failures; the hard line and the reactive path bypass it.
- `enabled: false` disables proactive early compaction only; the hard line, hard guard and reactive path stay armed.

### 4.2 Plan, size-aware tail

Keep the current plan and tool-pair guard. Add a size budget:

- Compute the kept tail (`keepRecentTurns` turns) plus system prompt and tools; if `tail + system + tools + O + R > W`, move the boundary later (keep fewer turns).
- The configured `keepRecentTurns` is a maximum, not a hard rule.
- **The latest user turn can be compacted too (revision 2026-11-15, maintainer decision: like Claude Code).** When the latest user turn alone does not fit, the boundary moves inside it, to a tool-pair boundary: a position where every tool call before it has its result before it. The kept tail shrinks pair by pair, down to the latest complete tool pair (the assistant tool calls and their results the next step answers); it never splits a pair. The summary still covers a contiguous prefix (`coversUpToSeq`), so the turn's opening user message is inside it, but the request keeps that message **verbatim**: when the latest summary's `coversUpToSeq` falls inside a user turn, request building re-renders the turn's opening `user_message` (as an ordinary user message renders: sender line, schedule header, media) after the summary text, in the summary's own user message. The model therefore always sees the task in the person's words, the summary of the earlier steps of this turn, and the latest steps verbatim. The re-rendered text is derived from the log, so it needs no `DriftReason`; logs written before this revision never cut inside a turn and rebuild unchanged. Interjections inside the turn that the summary covers stay in the summary only. The re-rendered message carries no skill fork report (a report whose invocation is covered follows the existing covered-invocation rule, so it is never shown twice); a run started by a background task, a sub-agent delivery or a manual compact has no opening user message to re-render. A long agent loop inside one user turn (sub-agents, scheduled tasks, one prompt with hundreds of tool calls) is compacted like any other history instead of only trimmed.
- If even the latest tool pair does not fit, 4.3 handles the remaining content.

### 4.2.1 Summary instruction (Claude Code template)

Adopt Claude Code's structured summary prompt (2.1.183), not the current free-form instruction:

- The model first writes an `<analysis>` scratchpad chronologically, then a `<summary>` with 9 sections: Primary Request and Intent; Key Technical Concepts; Files and Code Sections; Errors and fixes; Problem Solving; All user messages; Pending Tasks; Current Work; Optional Next Step. Each section keeps the template's detail requirements (file names, snippets, user feedback, verbatim quotes for the next step).
- Capybara stores only the `<summary>` block; the `<analysis>` block is discarded and never sent in a later request. If the model returns no `<summary>` tags, use the text minus any `<analysis>` block; if the result is empty, the attempt fails.
- Two Capybara adaptations stay: "Write in the same language as the conversation" and "If the transcript starts with an earlier summary, merge it into your summary."
- Raise `COMPACTION_MAX_OUTPUT_TOKENS` from 4096 to 20000 (capped by the model's max output); the 9-section summary plus analysis does not fit in 4096. The platform/org `maxOutputTokens` default follows (20000).
- Cost note: the prompt is longer and the summary is larger, so the post-compaction baseline is larger; the trigger and fit guard account for it.
- Domain note: the template is coding-oriented (files, code snippets). Capybara is a general agent platform; non-coding agents will write "not applicable"/omit those sections. Accepted.

### 4.3 Hard fit guard

Applied to every request after compaction and before sending:

1. Build the request and estimate its input.
2. Fit target: `W - O1 - R_eff`, not merely `< W`, where `O1 = min(O, W - 1)` (the cap bounded by the window only, never by the input) and `R_eff` is `R` reduced to what `O1` leaves. If `input <= target`, the provider-visible total fits with the safety reserve (providers that count `max_tokens` included).
3. If `input > target`, apply a deterministic fit plan:
   - Drop the oldest complete turns / tool pairs before the latest user turn, preferring tool results, then assistant text, until the input is at or below the fit target.
   - Then the oldest complete tool pairs inside the latest user turn (revision 2026-11-15), keeping the latest user message (when it is not inside the summary) and the latest complete tool pair. Never a pair's half, never the summary.
   - If that is still too large, truncate the kept messages' largest text / `tool_result` blocks and insert the English note `[content truncated to fit the model's context window]`.
   - Record the plan in `model_call.request.fit` (dropped seqs, truncated block identifiers). `buildRequest` applies a recorded plan, so reconstruction is byte-for-byte and old logs (no `fit`) rebuild as before. No `DriftReason`: it is in the log.
4. Clamp output **after** the plan, from the input actually sent: `O' = clamp(O1, 1, W - inputAfterFit)` (revision 2026-11-15: clamping from the pre-trim estimate sent a trimmed request with `maxOutputTokens: 1`). A plan that reached its target leaves `O' = O1`. The recorded `maxOutputTokens` is this `O'`.
5. If the plan cannot reach the target, compact once with `force: true` (4.4, the rung's model) and fit again. If it still cannot, fall back to the squeezed fit: the output cap is first lowered to what the pre-plan input leaves (`clamp(O1, 1, W - input)`), the plan is made against that smaller-output target, and the cap is clamped again from the post-plan input, so a trimmed request never goes out with a needlessly small cap. This keeps models whose output cap is close to or above their window usable (with `O1 ≈ W` the strict target is about 1 token). Only if the squeezed plan cannot reach its target either (system prompt + tools + summary + the kept latest pair too large), fail with `run.context_too_large` before any provider call. This is a configuration/input problem, not a history overflow.
   - Inside the summary message only the summary text is protected: the re-rendered opening user message (4.2) after it may be truncated like any kept text block.
6. Estimator error: a provider may still reject a request the estimate thought fits. On `context_overflow`, re-trim against 70%, then 80%, then 90% of `W` and use the most aggressive target the plan actually reaches (estimate after the plan at or below that target); when none is reached, the 70% plan (the most trimming possible) is sent. Bounded; this is the real backstop, not the estimate.

### 4.4 Reactive compaction

- `context_overflow` already exists as a `ModelErrorKind` (`packages/plugin-sdk/src/model.ts`); the kernel classifies it as `model.context_overflow` and currently treats it as a media rejection.
- On `model.context_overflow`:
  1. If the request carried media bytes, exclude them (`media_excluded`) and retry once **in the same step**. Today this only writes the event and fails the run; add the retry.
  2. Otherwise, or if the retry still overflows: run compaction with `force: true` (ignore threshold/backoff), rebuild and retry once.
  3. If it still overflows: apply 4.3 with progressive targets and retry once.
  4. Then surface `model.context_overflow`; never loop.
- Compaction in the reactive path uses the model of the rung that failed (`info`), not necessarily the agent's model; a fallback rung may have a smaller window, and the summary must fit it.
- Each overflow fix-up (media exclusion, compaction, trim) consumes one attempt; the ladder's three rungs are unchanged, so a step may write up to five `model_call` rows. Overflow fix-ups are bounded to one of each per rung.
- A fallback rung whose smaller window the local guard cannot reach (4.3 point 5) gets the same forced compaction with its own model before `run.context_too_large`; that forced compaction counts as the rung's one compaction fix-up.
- Every compaction a step runs has its own idempotency keys (revision 2026-11-15): the ordinal of the compaction among the step's `compaction_summary` / `compaction_failed` events, not the failure count. A proactive summary followed by a forced one in the same step therefore writes two summaries and two usage records; before, the second reused the first's key and was silently dropped while its call was still billed. Backoff keeps counting consecutive failures.

### 4.5 Chunked compaction fallback

- Budget `B = Wc - Cmax - R`, where `Wc` is the compaction model's window and `Cmax` is the compaction output cap (20000). Each call's input is `[running summary] + chunk` plus a fixed request overhead (the instruction and the transcript wrapper), so the base chunk size is `B - summaryAllowance - overhead`, where `summaryAllowance` (half of `Cmax`, rounded up) is the floor a later call reserves for its running summary; the first call has no summary.
- If the transcript estimate ≤ the base chunk size, one summary call as today. Otherwise the calls after the first shrink their chunk further to reserve the **actual** running summary's estimate (`[Earlier summary]` + the summary text) when it is larger than the allowance, so chunk + running summary + overhead always stays inside `B`. A degenerate budget (one that cannot fit the allowance, the overhead and a minimum chunk) leaves the single call as before.
- Otherwise split the transcript at line boundaries into chunks ≤ the chunk size and summarize sequentially with a rolling summary: call 1 summarizes chunk 1; call `i` summarizes `[running summary] + chunk i`. The last call's text is the summary; the acceptance check runs against the **full** transcript.
- A single line (usually a tool result) larger than the chunk size is hard-split at a character boundary with a `[chunk split]` marker rather than failing.
- Progress is real `i/N` only in this path.
- One `usage` event per call (`purpose: "compaction"`, optional `chunk` / `chunks`); the idempotency key includes the chunk index. Hooks fire per call with the existing compaction fields; a denial fails the whole compaction. The completed calls before a failure are still billed and reported.
- If any chunk call fails, write one `compaction_failed` (reason includes the chunk); no partial summary. The step then relies on 4.3.

### 4.6 Progress

- Ephemeral, multi-replica safe, in Redis: `capk:run-compaction:<runId>` with a TTL, `{ phase, step, chunk, chunks, chars, startedAt }`, updated on phase changes and throttled while the summary streams; a bus notification drives the conversation SSE.
- New SSE event `compaction` with the same fields. Phases: `preparing` → `summarizing` → `writing`; `chunk i/N` only in the chunked path.
- Frames carry the conversation and agent ids. A child run's compaction progress stays on the child's stream; the root does not render another agent's compaction row, so no spinner can be left waiting for a child's summary event.
- Not in the event log, no `DriftReason`, loss harmless (display only).
- The web shows a compacting row (spinner, elapsed, `i/N` when chunked) until the final `compaction_summary` / `compaction_failed` event; then the existing saved-tokens divider replaces it. No percentage in the single-request path.

### 4.7 Manual compaction

- Endpoint: `POST /api/v1/orgs/:orgId/conversations/:id/compact` (member+ with conversation access; 404 for eval conversations).
- Body: optional `clientRequestId` for idempotency. If a compact run is already queued/running, return it (`202 { runId }`). If an ordinary run is active, return `409 conversation.busy`; the UI disables the action while running.
- Execution: a compact run (`run_started.trigger: "compact"`, trigger account = caller) takes the conversation lock and calls the shared compaction service with `force: true`; it writes only `compaction_summary`/`compaction_failed` + usage, emits progress, and finishes. No user message, no model step.
- The effective definition and `Wc` are the model the next run would use (the conversation's selection, including `model_switched`); tools and media resolve as for a step; the compact run's events carry `step: 0`.
- The run appears in the timeline/trajectory as a compact run; step consumers skip runs with no model step.
- Manual compaction is allowed even when automatic compaction is disabled (explicit user action); the hard guard still applies.
- Audit: `conversation.compacted` with the caller and the run id, if the existing conversation actions are audited.

### 4.8 Settings

Platform (DeploymentSettings, super admin, hot): `compaction { enabled (default true), threshold (0.8; 0.5–0.95), keepRecentTurns (4; 0–20), reserveTokens (8000; 0–50000), maxOutputTokens (20000; 1024–32000) }`.

Org (org settings, org admin): the same fields, all optional; absent follows the platform, `null` clears; values validated against the same ranges.

**Decision (maintainer, 2026-11-14).** Platform settings live in `DeploymentSettings` (hot, super-admin UI); the two `KernelConfigSchema.runtime` compaction fields are removed (pre-0.1.0, no compat; `docs/config.md` and the schema change). Org overrides live in org settings. Precedence: org > platform DB > built-in.

Do not ship a three-layer precedence: `DEPLOYMENT_SETTINGS` fields carry zod defaults, so an env fallback would be unreachable, and `sandboxTiers` resolves env before stored settings, contradicting "env wins". The hard fit guard, reactive compaction and output clamp are not configurable and cannot be disabled.

UI: a "Conversation compaction" section on the platform settings page and the org settings page, with a "follow platform" state; design components only.

### 4.9 Events, replay, SDK

- `run_started.trigger` gains `"compact"` (display only).
- `usage` gains an optional `chunk` (the 1-based chunk a chunked compaction call summarised) and `chunks` (the number of calls the compaction attempted: the full count on a completed compaction, only the calls actually made on a failed or hook-denied one) (additive; old logs parse).
- `compaction_summary` gains an optional `savedTokens` (estimated transcript input minus summary output, floored at zero: a longer summary saved nothing), so the UI does not derive it from chunked usage; the divider shows no number when it is absent (older logs) or 0.
- `model_call.request` gains an optional `fit` plan (4.3); `buildRequest` applies it; old logs have none. Record `estimatedInputTokens` for the request **actually sent (post-fit)**; calibration and the trigger read that value.
- `compaction_failed.reason` carries the chunk information as text; no schema change.
- No new `ModelErrorKind` (`context_overflow` exists). No SDK hook payload change; chunk calls reuse the existing compaction hook fields.
- Step replay recomputes the fit against the candidate model's window. A candidate whose window forces a different fit than the recorded one gets a new `context_fit` `DriftReason` (added to `DRIFT_ORDER`); the baseline (same model) applies the recorded plan with zero drift.
- Zero-drift: add cases for a trimmed request, a reactive compaction retry, and a chunked compaction (summary event + usage + savedTokens); run `reconstruct.test.ts` and `rename-compat.test.ts` before and after.
- Full-run replay runs the same guard; a candidate model with a smaller window may compact or trim in the eval conversation, counted as real usage.

### 4.10 Web UI

- Title-menu entry "Compact conversation" (the existing `TitleBar` menu; **no new action/icon slot**, so no design-system change and no visual baseline regeneration) and a `/compact` built-in command in the composer (parsed before skill lookup; no arguments; a command-menu entry).
- Both call the compact endpoint; progress comes from the SSE `compaction` event.
- Disabled while a run is active; hidden for eval conversations.
- The compacting row shows spinner + elapsed, `i/N` when chunked; on completion the existing "Earlier conversation compacted · saved N" divider appears, using the summary event's `savedTokens`.
- i18n zh/en; `check:web-ui`; no new styles outside design components.

### 4.11 Failure matrix

| Situation | Behavior |
|---|---|
| Proactive compaction fails | `compaction_failed` + backoff; step sends if it fits, else 4.3 |
| Hard guard trims | request sent with `fit`; no error |
| Provider rejects despite the estimate | progressive trim (most aggressive reachable of 70 / 80 / 90% of W) + retry, bounded |
| Reactive compaction fails | trim + retry; then `model.context_overflow` |
| Media rejection with bytes | `media_excluded` + in-step retry |
| Chunk fails | one `compaction_failed` with the chunk; no partial summary |
| One user turn with a long tool loop outgrows the window | compacted inside the turn at a tool-pair boundary (4.2) |
| Guard cannot reach the target (incl. a smaller fallback window) | forced compaction once, fit again (4.3 point 5) |
| Prompt + tools + summary + latest pair too large | `run.context_too_large` before any provider call |
| Manual compact while busy | `409 conversation.busy` |
| Abort during compaction | run aborted; no partial summary event |
| `enabled: false` | no proactive early compaction; hard line/guard/reactive stay armed |

### 4.12 Tests and checks

- Unit: trigger formula, tail budget, fit plan determinism and truncation note, progressive trim targets, chunk splitting/rolling summary (including an oversized line), final-summary acceptance and `<summary>` extraction, settings precedence/ranges, backoff bypass.
- Runtime: model-fake `context_overflow` → media exclude / force compact / trim retries; hard guard; chunked compaction usage/hooks/savedTokens; zero-drift reconstruct with `fit` and `context_fit`.
- HTTP: compact endpoint (idle/busy/idempotent/eval 404/RBAC), SSE `compaction`, manual compact run.
- Dual replica: manual compact claim, no duplicate summary; progress in Redis.
- Web: `/compact`, title-menu action, compacting row, divider, savedTokens; i18n; `check:web-ui`.
- Evals: full-run replay with an overflowing candidate; summary/trim replay.
- `docs/config.md` and `KernelConfigSchema` change: the two `runtime` compaction fields are removed under the settings decision.

### 4.13 Phasing

1. Effective window + trigger + size-aware tail + hard fit guard + progressive trim + reactive retry + events/replay tests.
2. Claude Code summary template + chunked compaction + progress (SSE + web row).
3. Manual endpoint + compact run + UI action/command + platform/org settings.

## 5. Decisions for the builder

- Exact shape of `model_call.request.fit` and how `buildRequest` applies it.
- Whether the compact run reuses `run_started`/`run_finished` or a leaner run record; how eval/trajectory skip it.
- Exact chunk split point and the rolling-summary instruction.
- TTL and throttle for the progress key.
- Whether `conversation.compacted` audit is needed.

## 6. Deferred

- Background precompute of the summary.
- A `compaction` model purpose mapping (cheaper summary model).
- A real percentage in the single-request path (not possible without chunking).
- A policy for a single user message larger than the window other than truncation with a note.
