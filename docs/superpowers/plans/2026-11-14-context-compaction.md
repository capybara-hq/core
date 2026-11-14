# Context Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Capybara conversation compaction match the agreed Claude Code-aligned behavior: never surface a context-length error, trigger with an output reserve, keep recent turns, fall back to chunked summaries and a deterministic fit trim, show honest progress, allow manual compaction, and expose platform/org settings.

**Architecture:** A pure compaction/settings/fit pipeline in `packages/kernel/src/runtime/context`, wired into `runModelStep` before every request; a compact run reuses the run worker for manual compaction; progress is an ephemeral Redis+SSE channel; platform defaults live in `DeploymentSettings`, org overrides in org settings. The event log stays the source of truth: every trimmed/summarized request is reconstructible.

**Tech Stack:** TypeScript, NestJS, zod, LangGraph loop, BullMQ run worker, Redis, Next.js web app with `@capybara-hq/design`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-14-context-compaction-design.md`

**Base:** branch `docs/context-compaction-design` (this worktree) or `main` after the design/plan PR merges. Create one implementation worktree: `pnpm wt:new feat/context-compaction --from docs/context-compaction-design --no-install`.

## Global Constraints

- English for docs, code comments, identifiers and commit messages; model-facing text is English; UI copy goes through i18n (zh/en; zh uses 智能体/平台/超级管理员).
- The event log is the source of truth. Every model-visible input is in the log; run `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts` before and after request-building changes.
- Pre-0.1.0: change formats/names directly; no compatibility layers. Applied migrations stay immutable.
- Multi-replica: no in-process state; use Redis/PG; every `ctx.kv` write has a TTL; queue names and job ids contain no `:`.
- Kernel conventions: `@Injectable`, one module each, explicit `@Inject`, `createZodDto`, `pnpm check:kernel-conventions`; a new route needs a Platform operation or an exclusion with a reason (`pnpm check:platform-ops`).
- Config: every `KernelConfigSchema` field has `meta`; regenerate `docs/config.md` with `pnpm gen:config-docs`; `pnpm check:config-docs`.
- Web: design components only; thin `page.tsx` + client `view.tsx`; `defineQuery`/`useAppMutation`; no styles; `pnpm check:web-ui`.
- Compaction is synchronous at the step boundary; no background precompute. One summary request unless chunking is required.
- The hard fit guard, reactive retry and output clamp are not configurable off.
- Published-package changes get a changeset (`pnpm changeset`); commits are Conventional Commits.

## Review Focus

1. A provider that counts `max_tokens` in the window (DeepSeek) — the output clamp and the `W - O - R` fit target must prevent the 400. Test in Task 4.
2. An estimator that undercounts code/JSON — the progressive 90/80/70% trim must rescue the request without a loop. Test in Task 6.
3. A fallback rung with a smaller window — reactive compaction must use the rung's model, not the agent's. Test in Task 6.
4. A child run's compaction progress — it must not leave a spinner on the root thread. Test in Task 8.
5. A single enormous tool-result line during chunking — hard split with a marker, never fail the chunk. Test in Task 7.

---

## File Structure

**Create**
- `packages/kernel/src/runtime/compaction-settings.service.ts` — resolve platform + org compaction settings.
- `packages/kernel/src/runtime/context/fit.ts` — pure fit plan (drop/truncate) and application.
- `packages/kernel/src/runtime/compaction.service.ts` — shared compaction execution (auto + manual).
- `packages/kernel/src/runtime/compaction-progress.ts` — Redis ephemeral progress.
- `packages/kernel/src/conversations/compaction.controller.ts` (or a route on the conversations controller) + DTO.
- `packages/kernel/test/runtime/compaction-settings.test.ts`, `packages/kernel/test/runtime/context/fit.test.ts`, `packages/kernel/test/runtime/compaction-progress.test.ts`, `packages/kernel/test/conversations/compact.http.test.ts`.
- Web: `apps/web/src/components/conversation/CompactingRow.tsx`, `apps/web/src/components/settings/CompactionSection.tsx` (platform/org variants), `apps/web/test/compact-command.test.tsx`, `apps/web/test/compaction-settings.test.tsx`.

**Modify**
- `packages/kernel/src/identity/settings.ts`, `packages/kernel/src/orgs/settings.service.ts`, `packages/kernel/src/orgs/settings.controller.ts`, `packages/kernel/src/config/schema.ts`, `docs/config.md`.
- `packages/kernel/src/runtime/context/compaction.ts`, `packages/kernel/src/runtime/context/build.ts`, `packages/kernel/src/runtime/model-call.ts`, `packages/kernel/src/runtime/run-worker.ts`, `packages/kernel/src/runtime/run-queue.ts`, `packages/kernel/src/runtime/stream.ts`, `packages/kernel/src/runtime/subagents/progress.ts`.
- `packages/kernel/src/conversations/events.ts`, `packages/kernel/src/evals/reconstruct.ts`, `packages/kernel/src/evals/trajectory.ts`, `packages/kernel/src/evals/plan.ts`, `packages/kernel/src/runtime/usage-report.ts`.
- `packages/kernel/src/platform/ops/conversations.ops.ts`.
- Web: `apps/web/src/lib/conversations.ts`, `apps/web/src/lib/org-settings.ts`, `apps/web/src/lib/admin.ts`, `apps/web/src/components/conversation/ComposerBar.tsx`, `ConversationView.tsx`, `Thread.tsx`, `useConversation.ts`, `apps/web/src/app/(app)/admin/settings/view.tsx`, `apps/web/src/app/(app)/settings/organization/view.tsx`, i18n dictionaries.
- Tests: `packages/kernel/test/runtime/context/compaction.test.ts`, `packages/kernel/test/runtime/model-call.test.ts`, `packages/kernel/test/evals/reconstruct.test.ts`, `packages/kernel/test/evals/trajectory.test.ts`, `packages/kernel/test/evals/plan.test.ts` (or the existing plan test), `packages/kernel/test/admin/admin.http.test.ts`, `packages/kernel/test/orgs/orgs.http.test.ts`, `packages/kernel/test/platform/registry.test.ts`/parity, web tests.

---

### Task 1: Platform/org compaction settings and resolver

**Files:**
- Modify: `packages/kernel/src/identity/settings.ts`, `packages/kernel/src/orgs/settings.service.ts`, `packages/kernel/src/config/schema.ts`
- Create: `packages/kernel/src/runtime/compaction-settings.service.ts`
- Modify: `packages/kernel/src/runtime/model-call.ts` (`ModelStepDeps`, resolve in `runModelStep`, pass to `maybeCompact`)
- Modify: `packages/kernel/src/runtime/run-processors.ts` (provider wiring) if that is where `ModelStepDeps` is built; otherwise the module that builds it.
- Test: `packages/kernel/test/runtime/compaction-settings.test.ts`, `packages/kernel/test/identity/settings.test.ts`
- Docs: `docs/config.md` via `pnpm gen:config-docs`

**Interfaces:**
- Produces:
  - `export const COMPACTION_SETTINGS = z.object({ enabled: z.boolean().default(true), threshold: z.number().min(0.5).max(0.95).default(0.8), keepRecentTurns: z.number().int().min(0).max(20).default(4), reserveTokens: z.number().int().min(0).max(50000).default(8000), maxOutputTokens: z.number().int().min(1024).max(32000).default(20000) })`
  - `export type CompactionSettings = z.infer<typeof COMPACTION_SETTINGS>`
  - `export function effectiveCompactionSettings(platform: CompactionSettings, org: Partial<CompactionSettings> | undefined): CompactionSettings`
  - `export class CompactionSettingsService { resolve(orgId: string): Promise<CompactionSettings> }`
  - `ModelStepDeps.compactionSettings: Pick<CompactionSettingsService, "resolve">`
- `DEPLOYMENT_SETTINGS` gains `compaction: COMPACTION_SETTINGS.default({})`; `DEPLOYMENT_SETTINGS_PATCH` gains `compaction: COMPACTION_SETTINGS.partial().strict().optional()` (merge given fields).
- `OrgSettingsSchema` gains `compaction: COMPACTION_SETTINGS.partial().optional().catch(undefined)`; `OrgSettingsPatchSchema` gains `compaction: COMPACTION_SETTINGS.partial().nullable().optional()` (null clears the whole org override; a partial object merges into the stored fields).
- `KernelConfigSchema.runtime` loses `compactionThreshold` and `keepRecentTurns` (and their defaults).

- [ ] **Step 1: Write the failing settings tests**

In `packages/kernel/test/runtime/compaction-settings.test.ts`, assert:

```ts
expect(effectiveCompactionSettings({ ...defaults, threshold: 0.8 }, { threshold: 0.6 }).threshold).toBe(0.6);
expect(effectiveCompactionSettings({ ...defaults, threshold: 0.8 }, undefined).threshold).toBe(0.8);
expect(() => COMPACTION_SETTINGS.parse({ threshold: 0.99 })).toThrow();
expect(() => COMPACTION_SETTINGS.parse({ keepRecentTurns: 21 })).toThrow();
```

In `packages/kernel/test/identity/settings.test.ts`, assert `DEPLOYMENT_SETTINGS.parse({}).compaction` equals the defaults, the patch merges only given fields, and the parsed `runtime` no longer has the two removed keys.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/kernel/test/runtime/compaction-settings.test.ts packages/kernel/test/identity/settings.test.ts`
Expected: FAIL (module/exports missing).

- [ ] **Step 3: Implement the schemas, resolver and wiring**

Add the zod objects and patch fields as above. `CompactionSettingsService.resolve` reads `SettingsService.get()` for the platform value and `readOrgSettings(db, orgId)` for the org override, then calls `effectiveCompactionSettings`. Wire it into the `ModelStepDeps` construction and resolve once per `runModelStep`; pass the resolved object into `maybeCompact` instead of reading `runtime.compactionThreshold` / `runtime.keepRecentTurns`. Remove the two `KernelConfigSchema.runtime` fields and their defaults. Run `pnpm gen:config-docs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/kernel/test/runtime/compaction-settings.test.ts packages/kernel/test/identity/settings.test.ts`
Expected: PASS. Also run `pnpm check:config-docs` and `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/identity/settings.ts packages/kernel/src/orgs/settings.service.ts packages/kernel/src/config/schema.ts packages/kernel/src/runtime/compaction-settings.service.ts packages/kernel/src/runtime/model-call.ts packages/kernel/src/runtime/run-processors.ts packages/kernel/test/runtime/compaction-settings.test.ts packages/kernel/test/identity/settings.test.ts docs/config.md
git commit -m "feat(kernel): platform and org compaction settings"
```

---

### Task 2: Settings APIs and platform/org UI

**Files:**
- Modify: `packages/kernel/src/orgs/settings.controller.ts` (the PATCH DTO follows `OrgSettingsPatchSchema`; add tests for the new key)
- Test: `packages/kernel/test/admin/admin.http.test.ts`, `packages/kernel/test/orgs/orgs.http.test.ts`
- Web: `apps/web/src/app/(app)/admin/settings/view.tsx`, `apps/web/src/app/(app)/settings/organization/view.tsx`, `apps/web/src/lib/admin.ts`, `apps/web/src/lib/org-settings.ts`, i18n dictionaries
- Create: `apps/web/src/components/settings/CompactionSection.tsx`
- Test: `apps/web/test/compaction-settings.test.tsx`

**Interfaces:**
- Consumes: `CompactionSettings`, `COMPACTION_SETTINGS` from Task 1.
- The admin GET/PUT payloads expose `compaction`; the org GET/PATCH expose `compaction` (null clears).

- [ ] **Step 1: Write failing HTTP tests**

In `admin.http.test.ts`: PUT `/api/v1/admin/settings { compaction: { threshold: 0.7 } }`, GET returns `compaction.threshold = 0.7` and the other compaction fields at their defaults; an out-of-range threshold returns 400.
In `orgs.http.test.ts`: PATCH `/api/v1/orgs/:orgId/settings { compaction: { threshold: 0.6 } }`, GET returns it; PATCH `{ compaction: null }` removes it (GET follows the platform again).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/kernel/test/admin/admin.http.test.ts packages/kernel/test/orgs/orgs.http.test.ts`
Expected: FAIL (field rejected/not returned).

- [ ] **Step 3: Wire the APIs and the UI**

The schemas from Task 1 flow through the existing DTOs; ensure the settings services persist/merge `compaction` like the other object fields. Add a "Conversation compaction" section to the platform admin settings view (threshold, keep recent turns, reserve, max output, enabled) and to the org settings view (same fields with a "follow platform" checkbox); use `useAppMutation` and existing design form components; add zh/en strings.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run packages/kernel/test/admin/admin.http.test.ts packages/kernel/test/orgs/orgs.http.test.ts apps/web/test/compaction-settings.test.tsx`
Expected: PASS; then `pnpm check:web-ui`.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: expose compaction settings on the platform and org pages"
```

---

### Task 3: Effective window, trigger and size-aware tail

**Files:**
- Modify: `packages/kernel/src/runtime/context/compaction.ts`
- Test: `packages/kernel/test/runtime/context/compaction.test.ts`

**Interfaces:**
- Produces:
  - `export function compactionInputBudget(window: number, maxOutput: number, reserve: number): number` — `window - maxOutput - reserve`.
  - `export function shouldCompact(estimate: number, window: number, settings: CompactionSettings): boolean` — `estimate >= Math.min(settings.threshold * window, compactionInputBudget(...))` or `estimate + maxOutput > window`.
  - `export function compactionPlan(events: ConversationEvent[], settings: CompactionSettings, budget: number): { coversUpToSeq: number; transcript: string } | null` — the current plan plus the size-aware tail: while `estimate(system + tools + tail) + settings.maxOutputTokens + settings.reserveTokens > window`, move the boundary earlier, down to the latest user turn; return null when nothing remains.

- [ ] **Step 1: Write failing tests**

Assert: a 200k window, 16k output, 8k reserve triggers at 160k (0.8) but a 0.95 threshold routes through `min(190k, 176k)`; `estimate + output > window` triggers even with `enabled: false` (the hard line); a tail whose 4 turns exceed the budget keeps only the latest turn; a single turn still over the budget leaves the trim to Task 4 and the plan returns that turn only.

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/kernel/test/runtime/context/compaction.test.ts`
- [ ] **Step 3: Implement** the three functions; keep `keepToolPairs`.
- [ ] **Step 4: Run to verify pass** — same command.
- [ ] **Step 5: Commit** — `git commit -am "feat(kernel): reserve-aware compaction trigger and size-aware tail"`

---

### Task 4: Hard fit guard, recorded fit plan and replay

**Files:**
- Create: `packages/kernel/src/runtime/context/fit.ts`
- Modify: `packages/kernel/src/runtime/context/build.ts` (accept/apply a recorded `fit`), `packages/kernel/src/runtime/model-call.ts` (plan, apply, record `request.fit`, record the post-fit `estimatedInputTokens`), `packages/kernel/src/conversations/events.ts` (`model_call.request.fit`), `packages/kernel/src/evals/reconstruct.ts` (apply the recorded plan; recompute for a candidate; add `context_fit`)
- Test: `packages/kernel/test/runtime/context/fit.test.ts`, `packages/kernel/test/evals/reconstruct.test.ts`

**Interfaces:**
- Produces:
  - `export type FitPlan = { droppedSeqs: number[]; truncated: { seq: number; block: number; note: string }[] }`
  - `export function planFit(input: { events: ConversationEvent[]; request: ModelRequest; model: ModelInfo; maxOutputTokens: number; reserveTokens: number; estimate: number }): FitPlan | null`
  - `export function applyFit(request: ModelRequest, plan: FitPlan): ModelRequest`
  - `model_call.request.fit?: FitPlan`; `estimatedInputTokens` is the estimate of the request actually sent (post-fit).
- Produces: `DriftReason` gains `"context_fit"`, added to `DRIFT_ORDER` (after `media_changed`, before `tool_unmatched`).

- [ ] **Step 1: Write failing fit tests**

Assert: dropping the oldest tool results then assistant text until `input <= W - O - R`; never splitting a tool call/result pair; truncating one oversized block adds `[content truncated to fit the model's context window]`; `planFit` returns null when the request already fits; the same input produces the same plan (deterministic).

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/kernel/test/runtime/context/fit.test.ts`
- [ ] **Step 3: Implement `fit.ts` and wire it**

In `runModelStep`, after the final request build and before `model_call`, compute the post-compaction estimate; if over `W - O - R`, plan the fit, apply it, and record the plan in `model_call.request.fit` and the post-fit estimate in `estimatedInputTokens`. In `buildRequest`/`assembleModelRequest`, accept an optional recorded plan and apply it. If system + tools + the latest user turn still exceed the target, throw `RunError("run.context_too_large", ...)` before any provider call.

- [ ] **Step 4: Add the replay test**

In `reconstruct.test.ts`: a baseline request with a recorded `fit` reconstructs with `drift: []` and equals the sent request; a candidate model with a smaller window forces a different fit and yields `context_fit`; old logs without `fit` reconstruct byte-for-byte. Run:
`pnpm exec vitest run packages/kernel/test/runtime/context/fit.test.ts packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(kernel): hard fit guard with a replayable trim plan"`

---

### Task 5: Claude Code summary template and stored summary

**Files:**
- Modify: `packages/kernel/src/runtime/context/compaction.ts` (`COMPACTION_INSTRUCTION`, `COMPACTION_MAX_OUTPUT_TOKENS = 20000`, `extractSummary`), `packages/kernel/src/runtime/model-call.ts` (extract `<summary>`, compute `savedTokens`), `packages/kernel/src/conversations/events.ts` (`compaction_summary.savedTokens?`)
- Test: `packages/kernel/test/runtime/context/compaction.test.ts`, `packages/kernel/test/runtime/model-call.test.ts`

**Interfaces:**
- Produces: `export function extractSummary(text: string): string` — the `<summary>…</summary>` content; if absent, the text with any `<analysis>…</analysis>` removed; trimmed.
- `buildCompactionRequest(transcript, model, maxOutputTokens)` uses the effective settings value (default 20000), capped by the model's max output, not a hard-coded constant.
- `compaction_summary.payload` gains `savedTokens?: number` (estimated transcript input minus summary output).

- [ ] **Step 1: Write failing tests**

Assert: `extractSummary("<analysis>x</analysis><summary>\nS\n</summary>")` returns `"S"`; a plain summary without tags is returned; an analysis-only response returns `""` (the attempt fails); `COMPACTION_MAX_OUTPUT_TOKENS` is 20000 and the instruction contains all nine section names and the analysis/summary wrapper; a successful compaction writes `savedTokens > 0`.

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/kernel/test/runtime/context/compaction.test.ts packages/kernel/test/runtime/model-call.test.ts`
- [ ] **Step 3: Implement the template and extraction**

Use Claude Code's 9 sections: Primary Request and Intent; Key Technical Concepts; Files and Code Sections; Errors and fixes; Problem Solving; All user messages; Pending Tasks; Current Work; Optional Next Step. Keep the two Capybara adaptations: "Write in the same language as the conversation" and "If the transcript starts with an earlier summary, merge it into your summary." Store only `extractSummary(...)`; compute `savedTokens` from the transcript estimate minus the stored summary estimate.

- [ ] **Step 4: Run to verify pass** — same command.
- [ ] **Step 5: Commit** — `git commit -am "feat(kernel): adopt the structured compaction summary"`

---

### Task 6: Reactive compaction and the media-exclusion retry

**Files:**
- Modify: `packages/kernel/src/runtime/model-call.ts` (the attempt loop, `classify`, `excludeMedia`, `maybeCompact` force path)
- Test: `packages/kernel/test/runtime/model-call.test.ts`

**Interfaces:**
- Consumes: `planFit`/`applyFit` (Task 4), `CompactionSettings` (Task 1), model-fake's `fail:<kind>` script (`plugins/model-fake/src/script.ts` supports `context_overflow`).
- Behavior: on `model.context_overflow` — (1) if media bytes were sent, write `media_excluded` and retry the same rung once; (2) else force compaction (ignore threshold/backoff), rebuild and retry once; (3) else progressively trim to 90/80/70% of `W` and retry once; (4) surface the error. Each fix-up consumes an attempt; at most one of each per rung; the ladder keeps its three rungs; compaction in this path resolves the rung's model.

- [ ] **Step 1: Write failing runtime tests**

Using model-fake scripts: a `context_overflow` then success after forced compaction writes `compaction_summary` before the retried `model_call`; a media-carrying overflow writes `media_excluded` and retries in the same step; a fallback rung with a smaller window compacts against the fallback model; four consecutive overflows end with `model.context_overflow` and no loop (bounded `model_call` count).

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/kernel/test/runtime/model-call.test.ts`
- [ ] **Step 3: Implement** the overflow branch before the ladder advances; update the media path to retry.
- [ ] **Step 4: Run to verify pass** — same command.
- [ ] **Step 5: Commit** — `git commit -am "feat(kernel): react to context overflow instead of failing the run"`

---

### Task 7: Chunked compaction fallback

**Files:**
- Modify: `packages/kernel/src/runtime/context/compaction.ts` (`chunkTranscript`), `packages/kernel/src/runtime/model-call.ts` (rolling summary loop, per-chunk usage/hooks, failure), `packages/kernel/src/conversations/events.ts` (`usage.chunk?`)
- Test: `packages/kernel/test/runtime/context/compaction.test.ts`, `packages/kernel/test/runtime/model-call.test.ts`

**Interfaces:**
- Produces: `export function chunkTranscript(transcript: string, chunkSize: number): string[]` — line boundaries; a single line over `chunkSize` is hard-split at a character boundary with a `\n[chunk split]\n` marker; empty input returns `[]`.
- `usage.payload.chunk?: number` (1-based), `chunks?: number`; the idempotency key includes the chunk.

- [ ] **Step 1: Write failing tests**

Assert: a transcript of 3 chunks produces 3 usage events with `purpose: "compaction"` and `chunk` 1..3; the rolling summary is passed to call 2; an oversized single line is split rather than failing; a failing middle chunk writes one `compaction_failed` with the chunk in the reason and no summary.

- [ ] **Step 2: Run to verify failure** — the two test files.
- [ ] **Step 3: Implement** the chunk budget `B - summaryAllowance` (half of `maxOutputTokens`), the rolling loop, per-chunk hooks and usage. The final summary is checked against the full transcript.
- [ ] **Step 4: Run to verify pass** — same command.
- [ ] **Step 5: Commit** — `git commit -am "feat(kernel): chunk compaction when the transcript does not fit"`

---

### Task 8: Compaction progress

**Files:**
- Create: `packages/kernel/src/runtime/compaction-progress.ts`
- Modify: `packages/kernel/src/runtime/model-call.ts` (publish phases/chars), `packages/kernel/src/runtime/stream.ts` (`event: compaction`), `packages/kernel/src/runtime/subagents/progress.ts` (keep child progress on the child stream)
- Web: `apps/web/src/lib/conversations.ts` (frame type), `apps/web/src/components/conversation/useConversation.ts` (state), `apps/web/src/components/conversation/Thread.tsx` (row), i18n
- Create: `apps/web/src/components/conversation/CompactingRow.tsx`
- Test: `packages/kernel/test/runtime/compaction-progress.test.ts`, a conversation SSE HTTP test, `apps/web/test/compact-command.test.tsx` (row part)

**Interfaces:**
- Produces: `export type CompactionProgress = { phase: "preparing" | "summarizing" | "writing"; step: number; chunk?: number; chunks?: number; chars?: number; startedAt: number }`
- Redis key `capk:run-compaction:<runId>`, TTL 10 minutes, updated on phase changes and at most every 200 ms while text streams; a bus notification.
- SSE frame: `event: compaction`, `data: { runId, conversationId, agentId?, ...CompactionProgress }`.

- [ ] **Step 1: Write failing tests**

Assert: publishing progress writes the Redis key with a TTL and emits a bus message; the SSE stream emits `compaction`; a child's frame carries the child id and the root reducer ignores it; the row renders "Compacting…" and `1/3` when chunked; no fake percentage appears for a single call.

- [ ] **Step 2: Run to verify failure** — the kernel progress test and the web test.
- [ ] **Step 3: Implement** the Redis/bus/SSE path and the web row; clear on `compaction_summary`/`compaction_failed` by TTL and an explicit delete.
- [ ] **Step 4: Run to verify pass** — same command + `pnpm check:web-ui`.
- [ ] **Step 5: Commit** — `git commit -am "feat: show compaction progress"`

---

### Task 9: Manual compaction endpoint and compact run

**Files:**
- Create: `packages/kernel/src/runtime/compaction.service.ts` (extract the shared execution from `maybeCompact`)
- Modify: `packages/kernel/src/conversations/conversations.controller.ts` (or a new `compaction.controller.ts`) for `POST /api/v1/orgs/:orgId/conversations/:id/compact`; `packages/kernel/src/platform/ops/conversations.ops.ts` (`conversations.compact`, mirror route, errors)
- Modify: `packages/kernel/src/conversations/events.ts` (`run_started.trigger` gains `"compact"`), `packages/kernel/src/runtime/run-queue.ts`, `packages/kernel/src/runtime/run-worker.ts` (a compact run calls the service and finishes with no model step)
- Test: `packages/kernel/test/conversations/compact.http.test.ts`, `packages/kernel/test/conversations/runs.dual.test.ts` (or the existing dual test)

**Interfaces:**
- `POST .../compact` body `{ clientRequestId?: string }` → `202 { runId }`; `409 conversation.busy` if an ordinary run is active; `404` for eval conversations; member+ with access.
- A compact run uses the effective selection (`model_switched`) and `step: 0`; its `compaction_summary`/`usage` idempotency keys include the run id.
- `CompactionService.force(input): Promise<{ summarySeq: number | null; failed: boolean }>`.

- [ ] **Step 1: Write failing HTTP tests**

Assert: an idle conversation compacts and writes one `compaction_summary` + one `usage` with `purpose: "compaction"`, `step: 0`; a second request while the compact run is queued returns the same `runId`; a busy conversation returns 409; an eval conversation 404; a member without access 404; the Platform operation `conversations.compact` exists and mirrors the route.

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run packages/kernel/test/conversations/compact.http.test.ts`
- [ ] **Step 3: Implement** the route, service extraction, compact run path and Platform operation (or an exclusion with a reason). Wire the worker to finish a compact run without invoking the loop.
- [ ] **Step 4: Run to verify pass** — the HTTP test, the dual-replica test, `pnpm check:platform-ops`.
- [ ] **Step 5: Commit** — `git commit -am "feat(kernel): manual conversation compaction"`

---

### Task 10: Web manual compaction

**Files:**
- Modify: `apps/web/src/components/conversation/ComposerBar.tsx` (`/compact` before skill lookup), `ConversationView.tsx` (title-menu entry), `apps/web/src/lib/skills.ts` or a new command parser, the conversation query/mutation, i18n
- Test: `apps/web/test/compact-command.test.tsx`, `apps/web/test/conversation-page.test.tsx`

**Interfaces:**
- Consumes: `POST .../compact` (Task 9).
- `/compact` with arguments shows a hint and sends nothing; the title-menu entry is disabled while a run is active and hidden for eval conversations; both call the same mutation.

- [ ] **Step 1: Write failing web tests**

Assert: typing `/compact` calls the endpoint and does not send a user message; `/compact foo` shows the hint; the menu entry is disabled while `conv.running`; the compacting row appears from the SSE event.

- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run apps/web/test/compact-command.test.tsx`
- [ ] **Step 3: Implement** the command parse/intercept, the title-menu entry, and the mutation; add zh/en strings.
- [ ] **Step 4: Run to verify pass** — the web test + `pnpm check:web-ui`.
- [ ] **Step 5: Commit** — `git commit -am "feat(web): compact a conversation from the menu or /compact"`

---

### Task 11: Trajectory, evals, usage and final verification

**Files:**
- Modify: `packages/kernel/src/evals/trajectory.ts` (sum chunk usages, use `savedTokens`, skip compact runs in step pairing), `packages/kernel/src/evals/plan.ts` (a compact run has no step plan), `packages/kernel/src/runtime/usage-report.ts` (chunk usages keep `purpose: "compaction"`), `apps/web/src/lib/timeline.ts` (use `savedTokens`)
- Test: `packages/kernel/test/evals/trajectory.test.ts`, `packages/kernel/test/evals/plan.test.ts`, `packages/kernel/test/evals/run-replay.test.ts`
- Changeset: `.changeset/*.md` for `@capybara-hq/kernel` (minor) and `@capybara-hq/design`/web only if the design package changes (it does not).

**Interfaces:**
- Consumes: `usage.chunk`, `compaction_summary.savedTokens`, `run_started.trigger: "compact"`.

- [ ] **Step 1: Write failing tests**

Assert: a chunked compaction's run total is the sum of its chunk usages; the trajectory divider uses `savedTokens`; a compact run produces no step pair and no step-replay baseline; a full-run replay of a conversation with a compact run does not dispatch a tool or a step for it.

- [ ] **Step 2: Run to verify failure** — the three test files.
- [ ] **Step 3: Implement** the consumers and the changeset.
- [ ] **Step 4: Run the full verification**

Run, in order:
```bash
pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts
pnpm exec vitest run packages/kernel/test/runtime packages/kernel/test/conversations packages/kernel/test/evals
pnpm check
pnpm typecheck
pnpm lint
```
Expected: all pass. The full suite is `pnpm verify`.

- [ ] **Step 5: Commit** — `git commit -am "test(kernel): cover compaction usage and compact runs"`

---

## Self-Review

- Spec coverage: every §4 subsection maps to a task (4.1/4.2 → Task 3; 4.2.1 → Task 5; 4.3 → Task 4; 4.4 → Task 6; 4.5 → Task 7; 4.6 → Task 8; 4.7 → Tasks 9/10; 4.8 → Tasks 1/2; 4.9 → Tasks 4/5/7/11; 4.10 → Tasks 8/10; 4.11 → Tasks 4/6/9; 4.12 → each task + Task 11; 4.13 → task order).
- Type consistency: `CompactionSettings`, `FitPlan`, `CompactionProgress` are defined once and consumed by the names above.
- Review Focus: the five lines have tests in Tasks 4, 6, 6, 8, 7.
- Deferred: precompute, compaction purpose mapping, a true percentage in the single-call path (documented in the spec §6).
