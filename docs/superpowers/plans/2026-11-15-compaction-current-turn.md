# Compaction inside the current turn, and guard fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run never fails or degrades because one user turn's tool loop outgrows the window, and the hard fit guard sends a usable output cap.

**Architecture:** Compaction may cut inside the latest user turn at a tool-pair boundary (like Claude Code). The fit guard clamps the output cap after trimming, may drop old tool pairs inside the latest turn, compacts once before giving up, and the reactive trim picks the most aggressive reachable target. Each compaction in a step gets its own idempotency keys.

**Tech Stack:** TypeScript, vitest, kernel runtime (`packages/kernel/src/runtime`).

**Spec:** `docs/superpowers/specs/2026-11-14-context-compaction-design.md`, revision 2026-11-15 (§4.2, §4.3, §4.4, §4.11).

## Global Constraints

- The event log is the single source of truth; history sent to the model is append-only except for a new compaction summary. Plans (`model_call.request.fit`) and `coversUpToSeq` are recorded and replayed byte-for-byte; old logs must rebuild exactly as before.
- Run the zero-drift fixtures `packages/kernel/test/evals/reconstruct.test.ts` and `packages/kernel/test/evals/rename-compat.test.ts` (find the exact paths with `git ls-files | grep -E 'reconstruct.test|rename-compat'`) before and after your change; both must stay green.
- Never split a tool pair (an assistant message's tool calls and the results that answer them). Never drop or truncate the summary message or a system message.
- English for code, comments, test titles and commit messages. Conventional Commits, body lines ≤ 100 chars, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run single tests from the repo root: `pnpm exec vitest run <path>`. No fixed sleeps, no per-test timeouts.
- Stage only the files your task owns (`git add <paths>`); never `git add -A` / `commit -a`. Do not dispatch subagents.
- Pre-0.1.0: no compatibility shims for unreleased behavior.

## Review Focus

1. A summary that covers the latest `user_message`: the next request is system, summary, then the kept tool pairs; no orphan tool result, provider message alternation intact, skill fork reports and run context still placed (build.ts already handles covered invocations: verify, don't assume).
2. A request already over the window before trimming: after the fix it is sent with the full `O1` output cap, not 1.
3. A fallback rung with a smaller window: forced compaction with the rung's model, then fit; `run.context_too_large` only after that.
4. A proactive summary and a reactive forced one in the same step: two `compaction_summary` events, two usage records.
5. Crash-retry of a step: re-running the same compaction attempt writes nothing new (idempotency still holds).

---

## Wave 1 (parallel): T1, T2. Wave 2: T3.

### Task 1: Fit guard: clamp after the plan, pairs inside the latest turn, reachable reactive trim

**Files:**
- Modify: `packages/kernel/src/runtime/context/fit.ts`
- Modify: `packages/kernel/src/runtime/model-call.ts` (only the hard fit guard block around `request.maxOutputTokens = clampOutput(` and `reactiveTrimPlan`)
- Test: `packages/kernel/test/runtime/context/fit.test.ts`, the model-call test file that covers the guard (`grep -rln "context_too_large\|request.fit" packages/kernel/test/runtime`)

**Interfaces:**
- Produces: `fitTargetFor(contextWindow: number, maxOutputTokens: number, reserveTokens: number): { output: number; reserve: number; target: number }` in `fit.ts`, where `output = min(O, W - 1)` (at least 1), `reserve = effectiveReserve(W, output, R)`, `target = W - output - reserve`. `planFit` uses it (no longer clamps by the estimate). `FitPlan`'s shape does not change (it is in the log).
- Produces: `reactiveTrimPlan` returns the plan for the most aggressive factor in `REACTIVE_TRIM_FACTORS` whose `estimateAfterFit(...) <= fitTargetFor(factor × W, O, R).target`; when none is reached, the 0.7 plan. null only when the request fits every target.

- [ ] **Step 1: failing tests** in `fit.test.ts`:
  - `planFit` on a request whose estimate exceeds W returns a plan reaching `fitTargetFor(W,O,R).target` and the caller-side cap `clampOutput(W, O1, after)` equals `O1` (replace the old assertion that pinned `clampOutput(1_000, 5_000, 1_200) === 1` as the guard's outcome; `clampOutput` itself may keep its arithmetic).
  - In-turn drops: messages `[system, user(task), assistant(call A), user(result A), assistant(call B), user(result B), assistant(call C), user(result C)]` over target → the plan drops pairs A then B (oldest first), keeps `user(task)` and pair C; never drops one half of a pair.
  - When the summary message is the only typed-user-looking message (latest user message covered by the summary): `isTypedUser` must not treat the `<conversation_summary>` message as the latest user turn; pairs after it are droppable oldest first except the latest pair.
- [ ] **Step 2:** run them, see them fail.
- [ ] **Step 3: implement** in `fit.ts`: `fitTargetFor`; `planFit` computes the target with it; `isTypedUser` excludes the summary; after the existing three passes before the latest turn, a fourth pass drops complete tool pairs (assistant with tool calls + the following results-only message) inside the latest turn oldest first, stopping before the latest complete pair; then the existing truncation pass over the kept messages.
- [ ] **Step 4: model-call guard:** compute `{ output, reserve, target } = fitTargetFor(W, request.maxOutputTokens, compaction.reserveTokens)` from the unclamped cap; plan with it; after the plan set `request.maxOutputTokens = clampOutput(W, output, sentEstimate)` (the post-fit estimate). Recorded `maxOutputTokens` is this value. `reactiveTrimPlan` per the interface above. Keep the strict `run.context_too_large` throw for the ordinary guard for now (T3 adds the forced compaction before it).
- [ ] **Step 5: model-call tests:** a step whose built request is over W (model-fake) is sent with `maxOutputTokens === min(O, W-1)` and a `fit` plan; a reactive trim where 0.7 is unreachable but 0.8 is reachable uses the 0.8 plan.
- [ ] **Step 6:** run fit, model-call and both zero-drift files; all green. Commit `fix(kernel): clamp the output cap after the fit plan, not before it`.

### Task 2: Compaction may cut inside the latest user turn

**Files:**
- Modify: `packages/kernel/src/runtime/context/compaction.ts` (`compactionPlan`, `keepToolPairs`, `tailTokens` as needed)
- Test: `packages/kernel/test/runtime/context/compaction.test.ts`; a build test proving the request shape (find the existing build tests: `git ls-files packages/kernel/test | grep -i build`); `reconstruct.test.ts` (one new zero-drift case)

**Interfaces:**
- `compactionPlan(events, settings, budget)` keeps its signature and return shape. New behavior: candidate cut points are every `user_message` index **and** every index inside the latest user turn at which no tool call before it has its result at or after it (a tool-pair boundary, results that were never written don't count, as today). The size-aware tail first shrinks turn by turn as today; when the latest user turn alone is over `budget`, it moves the cut forward through that turn's pair boundaries, oldest first, until the tail fits or only the latest complete tool pair is left. `keepRecentTurns` semantics for earlier turns are unchanged.

- [ ] **Step 1: failing tests** in `compaction.test.ts`: one `user_message` followed by many tool pairs over `budget` → a plan whose `coversUpToSeq` lies inside the turn at a pair boundary (the user message and the oldest pairs are in the transcript; the kept tail starts with an assistant tool call); with a mid-run interjection `user_message` between a tool call and its result the cut never separates them; a single tool pair over budget → plan covers everything before that pair (or null if nothing precedes it).
- [ ] **Step 2: failing build test:** events where the summary covers the latest `user_message` → `buildModelRequest` gives `[system…, summary user message, assistant(call), user(result), …]`, every result's call present, no empty messages.
- [ ] **Step 3:** implement; run the tests green.
- [ ] **Step 4: zero-drift:** add a reconstruct case for a log with a mid-turn `compaction_summary` followed by a `model_call`; it must reconstruct byte-for-byte. Run both zero-drift files.
- [ ] **Step 5:** commit `feat(kernel): compact inside the current turn at a tool-pair boundary`.

### Task 3 (after T1): Distinct keys per compaction; compact once before `run.context_too_large`

**Files:**
- Modify: `packages/kernel/src/runtime/model-call.ts`
- Test: the model-call test file(s); `reconstruct.test.ts` only if a recorded shape changes (it should not)

**Interfaces:**
- Consumes: T1's guard block (`fitTargetFor`, post-fit clamp).
- Produces: `compactionOrdinal(events, runId, step): number` = 1 + the number of `compaction_summary` / `compaction_failed` events of this `runId` and `step`. `maybeCompact` uses it for `idem.compactionSummary/compactionFailed/compactionUsage` and the hook-denied key; `consecutiveCompactionFailures` stays for backoff only. The payload's `attempt` stays the backoff attempt.

- [ ] **Step 1: failing tests:** (a) proactive compaction succeeds, the provider then answers `context_overflow` (model-fake) → the forced compaction writes a second `compaction_summary` and a second compaction `usage` (distinct idem keys); (b) re-running the same step after a crash between the summary call and its write writes exactly one summary (idempotency kept); (c) the ordinary guard cannot reach its target (e.g. a fallback rung with a small window, or a huge latest turn) → one forced compaction with that rung's model, then the step proceeds; `run.context_too_large` only when system + tools + summary + latest pair still exceed the target; the forced compaction counts as the rung's `compactFixup`.
- [ ] **Step 2:** implement `compactionOrdinal` and switch the keys; in the rung loop, when the strict guard would throw and `compactFixup` is false, set `compactFixup = true`, run `maybeCompact(..., { force: true, ref: rung.ref, fallback: rung.fallback })`, rebuild and fit again within the same attempt (no extra `model_call` row, no provider call before it); throw only if it still does not fit.
- [ ] **Step 3:** run model-call tests, compaction tests, both zero-drift files; commit `fix(kernel): give each compaction in a step its own keys and compact before giving up`.

### Finish

- [ ] Changeset `@capybara-hq/kernel` patch describing the behavior changes.
- [ ] `pnpm verify` green; whole-branch review on the most capable model; PR.
