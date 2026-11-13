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
         → provider says context_overflow → compact (force) → retry once → trim → retry once
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

### 4.2 Plan, size-aware tail

Keep the current plan and tool-pair guard. Add a size budget:

- Compute the kept tail (`keepRecentTurns` turns) plus system prompt and tools; if `tail + system + tools + O + R > W`, move the boundary earlier (keep fewer turns), down to the latest user turn.
- The configured `keepRecentTurns` is a maximum, not a hard rule.
- If even one turn does not fit, 4.3 handles the remaining content.

### 4.3 Hard fit guard

Applied to every request after compaction and before sending:

1. Build the request and estimate its input.
2. Clamp output: `O' = clamp(O, 1, W - input)`. If `input < W`, this alone guarantees the provider-visible total fits (providers that count `max_tokens` included).
3. If `input >= W`, apply a deterministic fit plan:
   - Drop the oldest complete turns / tool pairs outside the latest user turn, preferring tool results, then assistant text, until the request fits with at least a small output floor (256).
   - If the latest user turn alone is too large, truncate its largest text / `tool_result` blocks and insert the English note `[content truncated to fit the model's context window]`.
   - Record the plan in `model_call.request.fit` (dropped seqs, truncated block identifiers). `buildRequest` applies a recorded plan, so reconstruction is byte-for-byte and old logs (no `fit`) rebuild as before. No `DriftReason`: it is in the log.
4. If system prompt + tools + the latest user message still exceed `W`, fail with a clear kernel error (`run.context_too_large`) before any provider call. This is a configuration/input problem, not a history overflow.

### 4.4 Reactive compaction

- `context_overflow` already exists as a `ModelErrorKind` (`packages/plugin-sdk/src/model.ts`); the kernel classifies it as `model.context_overflow` and currently treats it as a media rejection.
- On `model.context_overflow`:
  1. If the request carried media bytes, keep the existing media exclusion + retry.
  2. Otherwise, or if the retry still overflows: run compaction with `force: true` (ignore threshold/backoff), rebuild and retry once.
  3. If it still overflows: apply 4.3 and retry once.
  4. Then surface `model.context_overflow`; never loop.
- Each retry is a new hook attempt and is counted in usage.

### 4.5 Chunked compaction fallback

- Budget `B = Wc - Cmax - R`, where `Wc` is the compaction model's window (the agent's model in v1) and `Cmax` is the compaction output cap (4096).
- If the transcript estimate ≤ `B`, one summary call as today.
- Otherwise split the transcript at line boundaries into chunks ≤ `B` and summarize sequentially with a rolling summary: call 1 summarizes chunk 1; call `i` summarizes `[running summary] + chunk i`. The last call's text is the summary; the acceptance check runs against the **full** transcript.
- Progress is real `i/N` only in this path.
- One `usage` event per call (`purpose: "compaction"`, optional `chunk`); the idempotency key includes the chunk index. Hooks fire per call with the existing compaction fields; a denial fails the whole compaction.
- If any chunk call fails, write one `compaction_failed` (reason includes the chunk); no partial summary. The step then relies on 4.3.

### 4.6 Progress

- Ephemeral, multi-replica safe, in Redis: `capk:run-compaction:<runId>` with a TTL, `{ phase, step, chunk, chunks, chars, startedAt }`, updated on phase changes and throttled while the summary streams; a bus notification drives the conversation SSE.
- New SSE event `compaction` with the same fields. Phases: `preparing` → `summarizing` → `writing`; `chunk i/N` only in the chunked path.
- Not in the event log, no `DriftReason`, loss harmless (display only).
- The web shows a compacting row (spinner, elapsed, `i/N` when chunked) until the final `compaction_summary` / `compaction_failed` event; then the existing saved-tokens divider replaces it. No percentage in the single-request path.

### 4.7 Manual compaction

- Endpoint: `POST /api/v1/orgs/:orgId/conversations/:id/compact` (member+ with conversation access; 404 for eval conversations).
- Body: optional `clientRequestId` for idempotency. If a compact run is already queued/running, return it (`202 { runId }`). If an ordinary run is active, return `409 conversation.busy`; the UI disables the action while running.
- Execution: a compact run (`run_started.trigger: "compact"`, trigger account = caller) takes the conversation lock and calls the shared compaction service with `force: true`; it writes only `compaction_summary`/`compaction_failed` + usage, emits progress, and finishes. No user message, no model step.
- The run appears in the timeline/trajectory as a compact run; step consumers skip runs with no model step.
- Manual compaction is allowed even when automatic compaction is disabled (explicit user action); the hard guard still applies.
- Audit: `conversation.compacted` with the caller and the run id, if the existing conversation actions are audited.

### 4.8 Settings

Platform (DeploymentSettings, super admin, hot): `compaction { enabled (default true), threshold (0.8; 0.5–0.95), keepRecentTurns (4; 0–20), reserveTokens (8000; 0–50000), maxOutputTokens (4096; 256–16384) }`.

Org (org settings, org admin): the same fields, all optional; absent follows the platform, `null` clears; values validated against the same ranges.

Precedence: org > platform (DeploymentSettings) > existing `runtime.compactionThreshold` / `keepRecentTurns` (deployment env fallback) > built-in defaults. The hard fit guard, reactive compaction and output clamp are not configurable and cannot be disabled.

UI: a "Conversation compaction" section on the platform settings page and the org settings page, with a "follow platform" state; design components only.

### 4.9 Events, replay, SDK

- `run_started.trigger` gains `"compact"` (display only).
- `usage` gains an optional `chunk` for chunked compaction calls (additive; old logs parse).
- `model_call.request` gains an optional `fit` plan (4.3); `buildRequest` applies it; old logs have none.
- `compaction_failed.reason` carries the chunk information as text; no schema change.
- No new `ModelErrorKind` (`context_overflow` exists). No SDK hook payload change; chunk calls reuse the existing compaction hook fields.
- Zero-drift: add cases for a trimmed request, a reactive compaction retry, and a chunked compaction (summary event + usage); run `reconstruct.test.ts` and `rename-compat.test.ts` before and after.
- Full-run replay runs the same guard; a candidate model with a smaller window may compact or trim in the eval conversation, counted as real usage.

### 4.10 Web UI

- Title bar action "Compact conversation" (disabled while a run is active; hidden for eval conversations) and a `/compact` built-in command in the composer (parsed before skill lookup; no arguments; a command-menu entry).
- Both call the compact endpoint; progress comes from the SSE `compaction` event.
- The compacting row shows spinner + elapsed, `i/N` when chunked; on completion the existing "Earlier conversation compacted · saved N" divider appears.
- i18n zh/en; `check:web-ui`; no new styles outside design components.

### 4.11 Failure matrix

| Situation | Behavior |
|---|---|
| Proactive compaction fails | `compaction_failed` + backoff; step sends if it fits, else 4.3 |
| Hard guard trims | request sent with `fit`; no error |
| Reactive compaction fails | trim + retry; then `model.context_overflow` |
| Chunk fails | one `compaction_failed` with the chunk; no partial summary |
| Prompt + tools alone too large | `run.context_too_large` before any provider call |
| Manual compact while busy | `409 conversation.busy` |
| Abort during compaction | run aborted; no partial summary event |

### 4.12 Tests and checks

- Unit: trigger formula, tail budget, fit plan determinism and truncation note, chunk splitting/rolling summary, final-summary acceptance, settings precedence/ranges, backoff bypass.
- Runtime: model-fake `context_overflow` → force compact → retry; hard guard; chunked compaction usage/hooks; zero-drift reconstruct with `fit`.
- HTTP: compact endpoint (idle/busy/idempotent/eval 404/RBAC), SSE `compaction`, manual compact run.
- Dual replica: manual compact claim, no duplicate summary; progress in Redis.
- Web: `/compact`, title bar action, compacting row, divider; i18n; `check:web-ui`.
- Evals: full-run replay with an overflowing candidate; summary/trim replay.
- Config docs only if `KernelConfigSchema` changes (it does not in v1).

### 4.13 Phasing

1. Effective window + trigger + size-aware tail + hard fit guard + reactive retry + events/replay tests.
2. Chunked compaction + progress (SSE + web row).
3. Manual endpoint + compact run + UI action/command + platform/org settings.

## 5. Decisions for the builder

- Exact shape of `model_call.request.fit` and how `buildRequest` applies it.
- Whether the compact run reuses `run_started`/`run_finished` or a leaner run record; how eval/trajectory skip it.
- Exact chunk split point (line boundaries) and the rolling-summary instruction.
- TTL and throttle for the progress key.
- Whether `conversation.compacted` audit is needed.

## 6. Deferred

- Background precompute of the summary.
- A `compaction` model purpose mapping (cheaper summary model).
- A real percentage in the single-request path (not possible without chunking).
- A policy for a single user message larger than the window other than truncation with a note.
