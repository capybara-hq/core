# Idle Compaction Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, with the wave plan below (`wave-planned-subagent-development`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compact a large, idle chat conversation in the background shortly before its prompt cache of 30 minutes or more expires, using the in-context summary phase 1 built, so the person returning neither waits for a compaction nor pays a full-price re-read.

**Architecture:** At the finish of an eligible chat run the run worker computes a pure arm decision (settings, trigger, outcome, cache lifetime ≥ 1800 s, size, quality gate, settled point) outside any transaction; when it passes, `RunFinish.finishIn` owes a delayed `idle-compaction` job through the outbox in the terminal transaction. The job (on `cap-kernel-maintenance`, consumed under `WorkerModule` in `runJob` with the org scope) re-checks staleness, activity, settings, cache warmth, model, size and in-context applicability, then starts an idle compact run under the conversation row lock. That run takes the existing compact path with the in-context summary required and never falls back to the transcript. A person's input preempts it through the existing cross-replica abort channel (`run_aborted.reason: "superseded"`).

**Tech Stack:** TypeScript, NestJS kernel, Kysely + plain SQL migrations, BullMQ, transactional outbox, zod event schemas, vitest (unit / integration / container projects), Next web app with `@capybara-hq/design`, changesets.

**Spec:** `docs/superpowers/specs/2026-11-27-idle-compaction-design.md` §3–§8, §11 phase 2, §12; as amended by the resolutions in "Spec issues" below (Task 0). Phase 1 plan: `docs/superpowers/plans/2026-11-28-idle-compaction-phase1.md` (its rulings R8, R9/R9a/R9b, R11 and R13 bind this plan). Issue #974.

## Global Constraints

- Idle compaction exists only to beat the expiry of a cache of at least 30 minutes (spec §1 core rule). No fixed-delay mode, no transcript fallback: when the in-context summary does not apply, the idle attempt ends (`no_prefix`) and writes nothing.
- The idle compact run never sets `CompactOptions.manual` (ruling R13: manual compaction is transcript-only with the #990 plan). It sets `force: true` (the proactive trigger, `enabled` and backoff are the job's fire-time checks) and the new `requireInContext: true`.
- No new model-visible input, no `DriftReason`. `run_started.compactOrigin`, `run_aborted.reason: "superseded"` and `runs.compact_origin` are display / run-control fields. Zero-drift tests run before and after Tasks 6, 7 and 14: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts`.
- Multi-replica (AGENTS.md): the job is owed through `OutboxService.add` in the run-finish transaction; BullMQ is the only timer; job id `idle-compact-<runId>` (no `:`); the consumer is the existing `MaintenanceProcessor` (worker role only) inside `runJob` with `data.orgId`; the expiry is derived from the log, never held in memory; the run starts under the conversation row lock; preemption uses `RunAbort` (Redis marker + bus). Nothing that may need a network call (the model registry) runs inside a transaction.
- Every kernel table query with `org_id` runs under an org scope (`runJob` gives it); the new columns live on `runs` and `accounts`, which have no `org_id` (`check:org-filter` stays green without new policies).
- Migrations: plain SQL, `IF NOT EXISTS`, next free number on `origin/main` when the task starts (0192 today; re-check with `ls packages/kernel/src/migrations | tail -1`).
- Model-facing text: none added. UI text through i18n zh and en; zh says 平台 / 智能体 / 超级管理员, never 企业 or `agent` (`pnpm check:i18n`). apps/web writes no styles (`pnpm check:web-ui`).
- Tests: every new kernel unit test joins `packages/kernel/test/unit-tests.json` in the same commit (sorted position); every new container test joins `packages/kernel/test/container-tests.json` (extending `conversations/compact.dual.test.ts`, already listed, needs no new entry). Integration tests are one app per file; prefer extending existing files. No fixed sleeps, no per-test timeouts.
- Platform tool: no new route. Changed shared schemas keep `tools/checks/test/platform-parity.test.ts` and `pnpm check:platform-ops` green; operation descriptions that enumerate fields are updated with them.
- Kernel changes ship in the images: changeset on `@capybara-hq/capybara` and `@capybara-hq/kernel` (phase 1 lesson I2). Changesets go in `.changeset/<name>.md`, never `.changeset/pre/`.

## Coverage reality (what phase 2 does on day one)

State this in the PR description and the release notes.

| Model line (in-context gate, `IN_CONTEXT_SUMMARY_MODELS`) | Cache declaration | Lifetime ≥ 30 min? | Idle compaction |
|---|---|---|---|
| `claude-sonnet-*` | explicit, `[300, 3600]`, `refreshOnHit: true`, `request_start` | only with `promptCache.longTtl` on (1 h) | yes with `longTtl` on, if the reported window lets the threshold be reached (a 200k window never does, §4.1 table) |
| `qwen4-max*` | explicit, `[300, 3600]`, `refreshOnHit: false` (ruling R7) | only with `longTtl` on (1 h, counted from the write) | yes with `longTtl` on; the expiry is the last write + 1 h |
| `deepseek-flash*` | implicit, no lifetime, `guaranteed: false` | never | never |
| every `gpt-*` (not gated, #1002) | 5.6+: implicit `[1800, 43200]`, guaranteed | yes by default | never: the quality gate sends them to the transcript path, and idle compaction never uses it |
| `model-fake` (test entry) | `FAKE_CACHE` `[300, 3600]` or a scripted declaration | with `longTtl` on, or a scripted `defaultTtl ≥ 1800` | tests only |

**In the default configuration (`longTtl` off) nothing fires.** Idle compaction runs only where an admin turns on the long cache tier for a Sonnet or Qwen4-max line, until an OpenAI 5.6+ model passes the gate (#1002). The tests still cover the whole path with model-fake (a scripted cache with `ttlOptions` including a value ≥ 1800, listed in the gate as the test entry).

## Review Focus

1. **Post-finish side events.** The title and prompt-suggestion jobs append run-less `usage` events after the run ends. The staleness check must ignore them, or every job ends `obsolete` (spec issue S1). Test in Tasks 4 and 11.
2. **Preemption reaches a held conversation.** `RunQueue.ensureRun` returns before `ensureRunIn` while the run lock is held, so preemption must be decided before that early return (S2). Container test in Task 15.
3. **A superseded abort must not pause the queue or hold the tree.** `finishIn` pauses the queue for every non-`completed` status and holds the tree for a person's stop (S3). A queued message that preempted the idle run would otherwise stay paused. Test in Task 7.
4. **No transcript fallback under `requireInContext`.** Every in-context skip in an idle run writes nothing and finishes the run `completed`; a failed in-context call writes `compaction_failed` (check 6 backoff). Test in Task 6.
5. **Duplicate delivery and double fire.** Two deliveries of `idle-compact-<runId>` on two replicas start at most one run (the second sees the first run's `run_started` above `armedSeq`, or the active compact run). Container test in Task 15.
6. **Arming never slows or breaks a finish.** The arm decision runs outside the transaction and swallows its own errors (logged at `warn`, no job owed); the finish never fails because of it. Test in Task 9.

---

## Spec issues found against the code (resolutions proposed; Task 0 writes them into the spec)

"Behaviour" marks a resolution that changes what the spec says the product does; the rest only fix the mechanism.

| # | Spec text | What the code says now | Proposed resolution | Behaviour? |
|---|---|---|---|---|
| S1 | §4.3 check 2 and §5.1: the job proceeds only while the conversation's latest seq `== armedSeq` | the title job (`conversations/titles.ts` `appendUsage`) and the prompt-suggestion job (`prompt-suggestions.ts`) append `usage` events with `runId: null` after a completed run, so the latest seq almost always moves past `armedSeq` | stale = "an event after `armedSeq` other than a run-less side-call `usage` event (`type = 'usage' AND run_id IS NULL`)"; the same predicate is used at fire time and under the row lock at run start | no (restores the intent) |
| S2 | §5.2: preemption happens "in `ensureRunIn`" | `RunQueue.ensureRun` returns null before `ensureRunIn` whenever the conversation run lock has a holder, which is the case for a running idle compact run | `ensureRun`: when the lock is held, call a new `preemptIdleIn` transaction (reads only) that finds an active idle compact run and pending input; after the commit `RunAbort.request(runId, null, "superseded")`. A queued idle run (lock free) is ended inside `ensureRunIn`, which then creates the message's run in the same transaction | no |
| S3 | §5.2: the worker's existing abort branch writes `run_aborted`, then the message's run follows | `RunFinish.finishIn` pauses the conversation queue for every non-`completed` status (`pauseQueueIn`); `executeCompaction` always writes `reason: "user"`; `RunAbort` carries only `detail: "wait_timeout"` | `RunAbort` messages gain `reason?: "superseded"`; `executeCompaction` writes `{ byAccountId: null, reason: "superseded" }`; `finishIn` skips `pauseQueueIn` for a `run_aborted` whose reason is `superseded` (it has no account, so `personStopped` is already false: no tree hold) | no |
| S4 | §4.2: arm "at run finish (`RunFinish.finishIn`)" from facts "already in memory" | `finishIn` is a generic `mandatory`-transaction method used by every terminal path; it has no model declaration, and the model registry may call the provider's `listModels` (network) | the run worker computes the decision before calling `finish` (outside any transaction) and passes an `idleCompaction` intent in `FinishRunArgs`; `finishIn` owes the outbox row only when it wrote the terminal event, with `armedSeq` = that event's seq | no |
| S5 | §4.2 check 1: arm for triggers `message`, `background_task`, `subagent`; not `schedule` | `run_started.trigger` also has `automation_event` (collaboration spec §4.6); wakes inherit `runs.automation_run_id` from an unattended run | arm only when the trigger is absent/`message`, `background_task` or `subagent` **and** `runs.automation_run_id IS NULL` (no automation lineage); `automation_event` never arms | **yes**: a wake run continuing an automation's conversation does not arm (spec goal 2: "never on conversations nobody started by hand") |
| S6 | §4.2 check 4: "explicit, or implicit with a declared lifetime floor" | phase 1 encodes that as `ModelCacheInfo.guaranteed`, which `deriveCacheExpiry` already requires | the arm check is `deriveCacheExpiry(...) !== null && ttl >= 1800` over the run's calls (guaranteed, trusted declaration) | no |
| S7 | §4.2 has no quality-gate or settled-point check; §4.3 check 9 catches both at fire time | `inContextSummaryAllowed` (ruling R8) and `unansweredAfterReply` (R9) are pure; a `max_steps` / `max_output` run usually ends with tool results after the last reply (`pending_input`) | add both to the arm decision, so no job is owed that can only end `no_prefix` (spec anti-goal: "a job enqueued for every run whether or not it can ever fire") | no (same outcomes, fewer jobs) |
| S8 | §5.7 lists only `runs.compact_origin` | personal preferences are columns on `accounts` (`time_zone`, `theme`), not a JSON blob | the same migration adds `accounts.idle_compaction text NULL CHECK (idle_compaction = 'off')` | no |
| S9 | §6.2: the fields join the shared schemas "the existing Platform operations are built from"; "no exclusion is added" | `admin.update-settings` already `omits: ["compaction", …]` ("changed in the admin console's settings page"); `org-settings.update` and the `/me/preferences` operation enumerate their fields in the description | keep the existing omit (platform-level idle fields stay console-only, like every compaction field); add the three fields to the `org-settings.update` description and `idleCompaction` to the preferences operation's description | no (decision point D2) |
| S10 | §6.4: only a preempted idle run is silent | `apps/web/src/lib/timeline.ts` turns every compact run's `compaction_failed` into a `compact-failed` divider and its stop into `compact-stopped` | an idle run's failure is silent like an automatic one; its stop (superseded or a person's) shows nothing; only its summary draws the idle divider | **yes** for a person's stop of an idle run (spec covers only preemption; decision point D3) |
| S11 | §7 `idle_return`: "previous run ended more than 30 min earlier" | an idle compact run is itself a run and ends minutes before the return | "previous run" = the latest non-compact run of the conversation; "idle summary written in between" = a `compaction_summary` in a run with `compactOrigin: "idle"` after that run's end; logged at run start; the inline compaction time joins by `runId` with the existing `Compaction` log line | no |
| S12 | §5.1 "with `compact_origin = 'idle'`… existing compact runs read as manual" | manual runs are inserted by `startCompactionIn` with `compact: true` | new manual runs write `compact_origin = 'manual'`; `run_started.compactOrigin` is written only for idle runs (absent = manual), so manual runs' events are unchanged | no |
| S13 | §4.3 check 8 uses "the calibrated estimate of the next request" and "the part the plan would summarize" | both are computed inside `runCompaction` (private `buildRequest`, `compactionPlan`, `inContextSummary`) | split `runCompaction` into `prepareCompaction` (resolve, media, request estimate, plan, in-context build) and the call/acceptance part; the job uses it as a dry run (`CompactionService.probeIdle`), the run repeats it | no |
| S14 | §4.3 check 3 "suspended" | the active statuses are `queued`, `running`, `waiting` (`ACTIVE_RUN_STATUSES`) | read "suspended" as `waiting` | no |

---

## Wave plan

Risk per `wave-planned-subagent-development`: `high` = migration, multi-replica job lifecycle, preemption, the run-start path, request building. `high` tasks are reviewed alone on the most capable model; `normal` tasks of a wave share one batched review.

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 0 Spec amendments S1–S14 | — | spec only | normal | W1 | batched |
| 1 Migration + schema types | — | `migrations/0192_idle_compaction.sql`, `db/kernel-schema.ts` | high (migration) | W1 | alone, most capable |
| 2 Idle settings fields | — | `identity/settings.ts`, `orgs/settings.service.ts`, `platform/ops/org-settings.ops.ts`, settings tests | normal | W1 | batched |
| 3 Event schema | — | `conversations/events.ts`, `.agents/skills/replay-evals/SKILL.md` | normal | W1 | batched |
| 4 Pure rules | 2 (types), 3 | new `runtime/context/idle-compaction-rules.ts`, unit test, `unit-tests.json` | normal | W2 | batched |
| 5 Personal preference | 1 | `identity/me.schemas.ts`, `identity/accounts.ts`, `platform/ops/platform.ops.ts`, `test/runtime/run-context.http.test.ts` | normal | W2 | batched |
| 6 Compaction core: `requireInContext`, prepare / probe | 3 | `runtime/model-call.ts`, `runtime/compaction.service.ts`, `test/runtime/model-call.test.ts`, `test/conversations/compact.http.test.ts` | high (request building) | W2 | alone, most capable |
| 7 Idle run start + worker abort mapping | 1, 3, 6 | `runtime/run-queue.ts` (start only), `runtime/run-worker.ts` (compact path), `runtime/abort.ts`, `runtime/run-finish.ts` (queue pause), `runtime/run-control.ts` | high (run start) | W3 | alone, most capable |
| 10 Web settings + preference + i18n | 2, 5 (HTTP shapes) | `apps/web` settings sections, account preferences, `messages/{en,zh}.json`, web libs | normal | W3 | batched |
| 8 Preemption | 7 | `runtime/run-queue.ts` (`ensureRun` / `ensureRunIn`), `test/runtime/idle-preemption.test.ts` | high (preemption) | W4 | alone, most capable |
| 9 Arming at run finish | 4, 5, 7 | new `runtime/idle-arm.ts`, `runtime/run-worker.ts` (finish branches), `runtime/run-finish.ts` (intent), `infra/outbox/registry.ts`, new `runtime/idle-compaction-jobs.ts` | high (multi-replica job lifecycle) | W4 | alone, most capable |
| 12 Web conversation page | 3, 10 (i18n keys) | `apps/web/src/lib/timeline.ts`, `CompactingRow.tsx`, `Thread.tsx`, web tests | normal | W4 | batched |
| 11 The fire job | 4, 6, 7, 9 | new `runtime/idle-compaction.ts`, `runtime/maintenance.ts`, `runtime/runtime.module.ts`, `test/runtime/idle-compaction.test.ts` | high (multi-replica job lifecycle) | W5 | alone, most capable |
| 13 `idle_return` log | 9 | `runtime/run-worker.ts` (run start), new `runtime/idle-return.ts`, unit test | normal | W5 | batched |
| 14 Replay and eval planning | 11 | `test/evals/reconstruct.test.ts`, `test/evals/plan.test.ts` | normal | W6 | batched |
| 15 Container tests | 8, 11 | `test/conversations/compact.dual.test.ts` | high (multi-replica) | W6 | alone, most capable |
| 16 Restore D7 copy, docs, changesets | 10, 11 | `apps/web/messages`, `apps/web/test/prompt-cache-settings.test.tsx`, compaction spec, `.changeset/*.md` | normal | W7 | batched |
| — PR, release | all | | | | final whole-branch review (most capable) |

Shared-file rules:

- `packages/kernel/src/runtime/run-worker.ts`: Task 7 (compact path), Task 9 (finish branches), Task 13 (run start). Waves 3, 4 and 5; never two in one wave.
- `packages/kernel/src/runtime/run-queue.ts`: Task 7 (`startIdleCompaction`, `startCompactionIn`), Task 8 (`ensureRun`, `ensureRunIn`). Waves 3 and 4.
- `packages/kernel/src/runtime/run-finish.ts`: Task 7 (queue pause), Task 9 (intent). Waves 3 and 4.
- `apps/web/messages/{en,zh}.json`: Task 10 owns them in W3 and adds Task 12's conversation keys too (copy below); Task 16 restores the D7 sentence in W7.
- `packages/kernel/test/unit-tests.json`: Tasks 4 and 13 only (different waves).
- Task 2 and Task 6 both read `CompactionSettings`; Task 2 only adds fields, so Task 6's code compiles on either side of it.

## Release sequencing

1. One core PR (`feat/idle-compaction-phase2`, from `origin/main`), opened after W7, marked ready, final whole-branch review on the most capable model. Body: `Refs #974` (or the phase 2 issue), the coverage table, the spec issues S1–S14 as resolved, D1–D6.
2. Main merges it; the next Version Packages PR publishes the core release (`@capybara-hq/capybara` images and `@capybara-hq/kernel`). Release notes: "idle compaction: on by default (`idleEnabled`), runs only where a model's cache lasts ≥ 30 minutes and the in-context summary is gated; with the default `promptCache.longTtl: false` that is no model today; turning on the long tier costs every cache write the long tier's price (Anthropic about 2× instead of 1.25× of input)".
3. Main upgrades prod (`ssh prod`, official images only) and local dev. No plugins release is needed: phase 1's declarations (R3) are already pinned (#1019).
4. Two weeks of `IdleCompaction` and `idle_return` logs on prod (spec §10 step 3), then revisit the size defaults.

---

### Task 0: Spec amendments

**Files:**
- Modify: `docs/superpowers/specs/2026-11-27-idle-compaction-design.md` (§4.2, §4.3, §5.1, §5.2, §5.7, §6.2, §6.4, §7; a "Phase 2 plan review" entry in §12)

- [ ] **Step 1:** For each of S1–S14, edit the cited section to state the resolution (the plan table's last-but-one column) in the spec's voice; mark S5 and S10 "(behaviour change, decided in the phase 2 plan review)". Add to §12 one bullet per decision point D1–D6 with the maintainer's answer.
- [ ] **Step 2:** `pnpm check:agent-docs` and `pnpm lint` — PASS.
- [ ] **Step 3: Commit** `docs(idle-compaction): resolve the phase 2 spec issues`.

### Task 1: Migration and schema types

High risk (migration). Reviewed alone.

**Files:**
- Create: `packages/kernel/src/migrations/0192_idle_compaction.sql` (renumber if 0192 is taken when the task starts)
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`RunsTable.compact_origin`, `AccountsTable.idle_compaction`)
- Create: `packages/kernel/test/migrations/0192.test.ts` (integration, the per-migration pattern of `migrations/0190.test.ts`)

- [ ] **Step 1: Write the failing test**: after migrating, `information_schema.columns` has `runs.compact_origin` (text, nullable) and `accounts.idle_compaction` (text, nullable); inserting `compact_origin = 'other'` or `idle_compaction = 'on'` fails with a check violation; `'manual'`, `'idle'`, `'off'` and null succeed; running the migrations twice is a no-op.
- [ ] **Step 2: Run** the test — FAIL.
- [ ] **Step 3: Write the migration**:

```sql
-- Idle compaction (idle compaction spec §5.7): which compact runs were started by the idle job.
-- null = an ordinary run; a compact run written before this migration reads as manual.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS compact_origin text NULL
  CONSTRAINT runs_compact_origin_check CHECK (compact_origin IN ('manual', 'idle'));
-- The person's opt-out (spec §6.3): 'off' or null (follow the org).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS idle_compaction text NULL
  CONSTRAINT accounts_idle_compaction_check CHECK (idle_compaction = 'off');
```

  Types: `compact_origin: ColumnType<"manual" | "idle" | null, "manual" | "idle" | null | undefined, "manual" | "idle" | null>` with the doc comment "0192: …"; `idle_compaction: ColumnType<"off" | null, "off" | null | undefined, "off" | null>`.
- [ ] **Step 4: Run** the test, `pnpm check:org-filter`, `pnpm check` (applied-migration and numbering checks) — PASS.
- [ ] **Step 5: Commit** `feat(kernel): add runs.compact_origin and accounts.idle_compaction`.

### Task 2: Idle settings fields (platform and org)

**Files:**
- Modify: `packages/kernel/src/identity/settings.ts` (`COMPACTION_FIELDS`, `COMPACTION_SETTINGS`, `effectiveCompactionSettings`)
- Modify: `packages/kernel/src/orgs/settings.service.ts` only if its compaction merge lists fields (it reads `COMPACTION_SETTINGS_PARTIAL`; verify)
- Modify: `packages/kernel/src/platform/ops/org-settings.ops.ts` (the `org-settings.update` description's compaction clause)
- Modify: `packages/kernel/test/runtime/compaction-settings.test.ts`, `packages/kernel/test/identity/settings.test.ts`, `packages/kernel/test/orgs/settings.test.ts` (and any full-object assertion of the settings, e.g. `test/admin/admin.http.test.ts`: phase 1 CI lesson)

**Interfaces (produces):**

```ts
// COMPACTION_FIELDS gains:
idleEnabled: z.boolean(),
idleMinTokensFloor: z.number().int().min(50_000).max(2_000_000),
idleMinWindowRatio: z.number().min(0.1).max(0.9),
// COMPACTION_SETTINGS defaults: idleEnabled true, idleMinTokensFloor 200_000, idleMinWindowRatio 0.3
```

- [ ] **Step 1: Write the failing tests**: `COMPACTION_SETTINGS.parse({})` has the three defaults; `effectiveCompactionSettings(platform, { idleEnabled: false })` is off with the platform's size fields; the patch rejects `idleMinTokensFloor: 49_999`, `2_000_001`, `idleMinWindowRatio: 0.95` and a misspelled `idleEnable` (strict); HTTP: `PUT /api/v1/admin/settings { compaction: { idleEnabled: false } }` then `GET` returns it with the other compaction fields unchanged; the org patch `{ compaction: { idleMinTokensFloor: 300000 } }` then `{ compaction: null }` follows the platform again.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/compaction-settings.test.ts packages/kernel/test/identity/settings.test.ts packages/kernel/test/orgs/settings.test.ts` — FAIL.
- [ ] **Step 3: Implement**; extend the `org-settings.update` description: "compaction ({ enabled?, threshold?, keepRecentTurns?, reserveTokens?, maxOutputTokens?, idleEnabled? (compact idle conversations before a cache of 30 minutes or more expires), idleMinTokensFloor? (50000 to 2000000), idleMinWindowRatio? (0.1 to 0.9) } …)". The `admin.update-settings` omit of `compaction` stays (S9, D2).
- [ ] **Step 4: Run** the tests, `pnpm exec vitest run tools/checks/test/platform-parity.test.ts`, `pnpm check:platform-ops`, `pnpm check:web-api-parity` — PASS (if web-api-parity needs the web type, add only the type fields in `apps/web/src/lib/admin.ts` / `org-settings.ts`; Task 10 owns the rest, phase 1 ruling R3).
- [ ] **Step 5: Commit** `feat(settings): add the idle compaction settings`.

### Task 3: Event schema

**Files:**
- Modify: `packages/kernel/src/conversations/events.ts` (`run_started.compactOrigin`, `run_aborted.reason`)
- Modify: `packages/kernel/test/conversations/events.test.ts`
- Modify: `.agents/skills/replay-evals/SKILL.md` (one bullet: `compactOrigin` and `superseded` are not model-visible; idle compact runs are skipped by eval planning like manual ones)

- [ ] **Step 1: Write the failing test**: `run_started` with `trigger: "compact", compactOrigin: "idle"` parses; `compactOrigin: "manual"` parses; `compactOrigin: "other"` fails; `run_aborted { byAccountId: null, reason: "superseded" }` parses; an old `run_started` without the field parses.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**: `compactOrigin: z.enum(["manual", "idle"]).optional()` documented "display only: which compact run (absent = manual); never model-visible"; `reason` enum gains `"superseded"` documented "an idle compact run preempted by input (idle compaction spec §5.2); no account".
- [ ] **Step 4: Run** the test and the zero-drift file — PASS.
- [ ] **Step 5: Commit** `feat(conversations): record the idle compact origin and the superseded abort`.

### Task 4: Pure rules

**Files:**
- Create: `packages/kernel/src/runtime/context/idle-compaction-rules.ts`
- Create: `packages/kernel/test/runtime/context/idle-compaction-rules.test.ts` (unit; add `"runtime/context/idle-compaction-rules.test.ts"` to `packages/kernel/test/unit-tests.json` at its sorted position)

**Interfaces (produces):**

```ts
export const IDLE_MIN_CACHE_TTL = 1800;           // seconds
export const IDLE_MIN_GROWTH_TOKENS = 20_000;
export function idleMinTokens(window: number, s: Pick<CompactionSettings, "idleMinTokensFloor" | "idleMinWindowRatio">): number;
/** S1: an event that does not make an armed idle job stale (a run-less side-call usage). */
export function isIdleNeutralEvent(e: Pick<ConversationEvent, "type" | "runId">): boolean;
export type IdleArmSkip = "kind" | "trigger" | "automation" | "outcome" | "disabled" | "personal_off"
  | "no_cache" | "short_ttl" | "small" | "quality_gate" | "unsettled";
export interface IdleArmFacts {
  conversationKind: "chat" | "subagent" | "eval";
  trigger: RunStartedTrigger | undefined;        // run_started.trigger
  automationRunId: string | null;                // runs.automation_run_id (S5)
  outcome: "completed" | "max_steps" | "max_duration" | "budget" | "max_output";
  settings: CompactionSettings;                  // effective for the org
  personalOff: boolean;                          // accounts.idle_compaction = 'off' of the owner
  expiry: CacheExpiry | null;                    // deriveCacheExpiry over the run's calls (S6)
  lastCall: { provider: string; model: string; window: number;
              input: number; cacheRead: number; cacheWrite: number; output: number } | null;
  inContextAllowed: boolean;                     // inContextSummaryAllowed(provider, model) (S7)
  settled: boolean;                              // !unansweredAfterReply(...) at the run's end (S7)
}
export function idleArmDecision(f: IdleArmFacts):
  | { arm: true; runAt: number; expiresAt: number; cacheCallSeq: number }
  | { arm: false; reason: IdleArmSkip };
export type IdleFireOutcome = "gone" | "obsolete" | "busy" | "disabled" | "expired" | "backoff"
  | "no_model" | "small" | "no_prefix";
export interface IdleFireFacts {
  live: boolean;                 // org, conversation (chat), agent not deleted
  stale: boolean;                // an event after armedSeq that isIdleNeutralEvent rejects (S1)
  busy: boolean;                 // an active run, an unconsumed message, or a queue head
  enabled: boolean;              // effective enabled && idleEnabled && !personalOff (live)
  now: number; expiresAt: number;
  backoff: boolean;              // latest compaction record after the latest summary is compaction_failed
  sameModel: boolean;            // effective definition's model resolves, is enabled, equals the cacheCallSeq call's
  probe: { estimate: number; window: number; growth: number; planned: boolean } | null;
  inContext: boolean;            // the probe's in-context build applied (no skip)
  settings: CompactionSettings;
}
export function idleFireDecision(f: IdleFireFacts): { fire: true } | { fire: false; outcome: IdleFireOutcome };
```

Rules: `idleArmDecision` checks in order kind (`chat`), trigger (absent, `message`, `background_task`, `subagent`), automation (`automationRunId === null`), outcome (not `budget`), settings (`enabled && idleEnabled`), personal, cache (`expiry !== null`), ttl (`expiry.ttl >= 1800`), size (`input + cacheRead + cacheWrite + output >= idleMinTokens(window)`), quality gate, settled; `runAt = expiry.fireAt` (already `min(t0 + 0.9 L, expiresAt − 30 s)`). `idleFireDecision` checks in spec §4.3 order 1–9; `expired` when `now >= expiresAt − CACHE_EXPIRY_MARGIN_MS`; `small` when `probe === null || !probe.planned || probe.estimate < idleMinTokens(probe.window) || probe.growth < IDLE_MIN_GROWTH_TOKENS`.

- [ ] **Step 1: Write the failing tests**: the §4.1 table through `idleMinTokens` (128k → 200000, 200k → 200000, 256k → 200000, 400k → 200000, 1M → 300000; floor 50000 ratio 0.1 on 400k → 50000); arm: each skip reason with all other facts passing (including `trigger: "schedule"`, `"automation_event"`, `"compact"`, a wake with `automationRunId` set, `outcome: "budget"`, `ttl: 300`, a 200k-window call at 199k, `inContextAllowed: false`, `settled: false`), and the pass case's `runAt` equal to `expiry.fireAt` (1 h tier: `t0 + 3240 s`); fire: each outcome in order (when two checks fail, the earlier outcome wins), `expired` at exactly `expiresAt − 30 s` and not 1 ms earlier; `isIdleNeutralEvent` true for `{ type: "usage", runId: null }`, false for a `usage` with a run, a `user_message`, a `model_switched`, a `permission_profile_changed`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/context/idle-compaction-rules.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(runtime): add the idle compaction arm and fire rules`.

### Task 5: Personal preference

**Files:**
- Modify: `packages/kernel/src/identity/me.schemas.ts` (`PreferencesSchema.idleCompaction`, `Preferences.idleCompaction`)
- Modify: `packages/kernel/src/identity/accounts.ts` (`preferences`, `setPreferences`; new `idleCompactionOff(accountId): Promise<boolean>` for the runtime)
- Modify: `packages/kernel/src/identity/me.controller.ts` (doc comments only)
- Modify: `packages/kernel/src/platform/ops/platform.ops.ts` (descriptions of the two `/me/preferences` operations)
- Modify: `packages/kernel/test/runtime/run-context.http.test.ts` (the existing `/me/preferences` round trips)

- [ ] **Step 1: Write the failing tests**: `GET /api/v1/me/preferences` returns `idleCompaction: null`; `PUT { idleCompaction: "off" }` returns and persists `"off"` and leaves `timeZone` / `theme` unchanged; `PUT { idleCompaction: null }` clears it; `PUT { idleCompaction: "on" }` is 400 `validation_failed`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (`idleCompaction: z.literal("off").nullable().optional()`, documented "idle compaction spec §6.3: off = never compact this person's conversations while idle; null = follow the org; a narrowing only").
- [ ] **Step 4: Run** the test, `platform-parity.test.ts`, `pnpm check:platform-ops`, `pnpm check:web-api-parity` — PASS.
- [ ] **Step 5: Commit** `feat(identity): let a person turn idle compaction off`.

### Task 6: Compaction core — `requireInContext`, prepare and probe

High risk (request building). Most capable model; reviewed alone.

**Files:**
- Modify: `packages/kernel/src/runtime/model-call.ts` (`CompactOptions`, `runCompaction` split into `prepareCompaction` + the call part, `inContextSummary` unchanged in behaviour)
- Modify: `packages/kernel/src/runtime/compaction.service.ts` (`force(input, origin)`, new `probeIdle`)
- Modify: `packages/kernel/test/runtime/model-call.test.ts`, `packages/kernel/test/conversations/compact.http.test.ts`

**Interfaces (produces):**

```ts
// CompactOptions:
/** The idle compact run (idle compaction spec §4.3 check 9): an in-context skip ends the
 *  compaction with nothing written; never the transcript request. Implies nothing about `manual`. */
requireInContext?: boolean;
// model-call.ts
export interface PreparedCompaction { estimate: number; window: number; growthTokens: number;
  plan: CompactionPlan; inContext: InContextSummary | { skip: InContextFallback }; /* + what the call part needs */ }
export async function prepareCompaction(deps, input, events, runtime, compaction, tools, opts):
  Promise<PreparedCompaction | { skipped: "trigger" | "backoff" | "no_plan" | "unavailable" }>;
// compaction.service.ts
export type CompactOrigin = "manual" | "idle";
force(input: ForceCompactionInput, origin: CompactOrigin = "manual"): Promise<ForcedCompaction>;
// manual → { force: true, manual: true } (unchanged); idle → { force: true, requireInContext: true }
probeIdle(input: Omit<ForceCompactionInput, "runId" | "signal" | "accountId">):
  Promise<{ estimate: number; window: number; growth: number; planned: boolean; inContext: boolean }>;
```

`growthTokens` = the estimated tokens of the plan's transcript (what is not yet covered by a summary). `prepareCompaction` does everything `runCompaction` does today before the first progress update (resolve, `loadMedia`, `buildRequest`, calibrated estimate, trigger and backoff unless `force`, plan, `inContextSummary`) and writes nothing; the manual-only outcomes (`compaction_skipped`, `unavailable` → `compaction_failed`) stay in `runCompaction`. `probeIdle` runs it with `{ force: true, requireInContext: true }`, a placeholder run id (`00000000-0000-0000-0000-000000000000`, never written) and an aborted-never signal.

- [ ] **Step 1: Run the zero-drift baseline** — PASS (record it).
- [ ] **Step 2: Write the failing tests** in `model-call.test.ts` (model-fake, gate entry, a cached system block):
  - `requireInContext` with a model switched since the last call (`model_mismatch`) writes no event at all and returns `{ summarySeq: null, failed: false }`; the same with an unanswered tool result after the last reply (`pending_input`) and with `fit_plan`;
  - `requireInContext` on a settled conversation writes `compaction_summary.method: "in_context"` with a `usage` of purpose `compaction` and `cacheReadTokens > 0`;
  - `requireInContext` whose in-context call fails with a non-retryable request error writes `compaction_failed` (no transcript retry);
  - `prepareCompaction` writes no event and returns the same `estimate` and plan as a following `runCompaction` (no events in between);
  - regression: the reactive path (`transcriptOnly`) and a manual compaction (`manual`) behave exactly as before (existing tests pass unchanged).
- [ ] **Step 3: Write the failing tests** in `compact.http.test.ts`: `CompactionService.force(input, "idle")` on a finished conversation writes `method: "in_context"` and no `compaction_skipped` when the plan is empty (silent); `probeIdle` on the same conversation returns `inContext: true` and `planned: true`, and on a conversation whose last call was another model `inContext: false`.
- [ ] **Step 4: Run** both files — FAIL. **Step 5: Implement** the split mechanically (no behaviour change for the existing callers), then `requireInContext` (an in-context skip → log `debug` with the reason and `return skipped(events)`), then `force(…, origin)` and `probeIdle`.
- [ ] **Step 6: Run** both files, `packages/kernel/test/runtime/context/current-turn-compaction.test.ts`, `packages/kernel/test/runtime/permission-context-boundary.test.ts` and the full zero-drift file — PASS.
- [ ] **Step 7: Commit** `feat(runtime): require the in-context summary for idle compaction`.

### Task 7: Idle run start and the worker side of preemption

High risk (run start path). Most capable model; reviewed alone.

**Files:**
- Modify: `packages/kernel/src/runtime/run-queue.ts` (`startIdleCompaction` + its transaction; `startCompactionIn` writes `compact_origin: 'manual'`)
- Modify: `packages/kernel/src/runtime/run-worker.ts` (the run select gains `compact_origin`; `executeCompaction` passes the origin to `force` and `appendRunStarted`; its abort branch maps `superseded`)
- Modify: `packages/kernel/src/runtime/abort.ts` (`RunAbortBy.reason?: "superseded"`, carried by `request` / `watch` / `requested`)
- Modify: `packages/kernel/src/runtime/run-finish.ts` (no `pauseQueueIn` for a superseded abort)
- Modify: `packages/kernel/src/runtime/run-control.ts` (`requestAbort` signature passes the reason through, if the queue needs it)
- Test: `packages/kernel/test/conversations/compact.http.test.ts` (extend)

**Interfaces (produces):**

```ts
// RunQueue
/** Starts an idle compact run (spec §5.1) or returns null (never throws): under the conversation
 *  row lock it re-checks live / not stale (isIdleNeutralEvent after armedSeq) / not busy. */
startIdleCompaction(conversationId: string, armedSeq: number): Promise<string | null>;
// RunAbort
request(runId: string, byAccountId: string | null, opts?: { detail?: RunAbortDetail; reason?: "superseded" }): Promise<void>;
```

`startIdleCompactionIn` (`@Transactional({ propagation: "requires_new" })`, `// org-filter:` marker naming the job's kernel-written id): lock the conversation row (`forUpdate`); refuse (null) when the conversation is not live, not `chat`, the org is not live, the agent is deleted, an event after `armedSeq` is not neutral, an active run exists (any status in `ACTIVE_RUN_STATUSES`), `newest user_message seq > consumed_seq`, or a queue head exists; else insert the run exactly as `startCompactionIn` does (`jobIdFor(consumed_seq)`, `oweJob`, `compact: true`) with `compact_origin: 'idle'` and `trigger_account_id = conversations.account_id`.

- [ ] **Step 1: Write the failing tests** (`compact.http.test.ts`, model-fake gate entry):
  - `startIdleCompaction(conv, armedSeq)` on a settled conversation returns a run id; the run finishes `completed` with `run_started { trigger: "compact", compactOrigin: "idle", triggerAccountId: <owner> }`, a `compaction_summary` with `method: "in_context"`, and `runs.compact_origin = 'idle'`;
  - it returns null when a message arrived after `armedSeq`, when a run is active, when a queue head exists; it returns a run id when only a title `usage` (run-less) was appended after `armedSeq` (S1);
  - a manual `POST …/compact` while the idle run is active returns the idle run's id (spec §5.2, existing `startCompactionIn` behaviour, now asserted);
  - a manual compact run's row has `compact_origin = 'manual'` and its `run_started` has no `compactOrigin`;
  - `RunAbort.request(idleRunId, null, { reason: "superseded" })` while model-fake holds the summary call: the run ends with `run_aborted { byAccountId: null, reason: "superseded" }`, no `compaction_summary`, `conversations.queue_paused` stays false and `tree_stopped_at` stays null (S3).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the file, `packages/kernel/test/runtime/queued-abort.test.ts` and `packages/kernel/test/conversations/conversations.http.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(runtime): start idle compact runs and end them as superseded`.

### Task 8: Preemption

High risk (preemption, multi-replica). Most capable model; reviewed alone.

**Files:**
- Modify: `packages/kernel/src/runtime/run-queue.ts` (`ensureRun`, `ensureRunIn`, new `preemptIdleIn`, a `RunAbort` dependency)
- Create: `packages/kernel/test/runtime/idle-preemption.test.ts` (integration, one app)

Behaviour (S2):
- `ensureRun`: when `lock.holder(conversationId) !== null`, call `preemptIdleIn(conversationId)` (a `requires_new` transaction that only reads: the active run with `compact_origin = 'idle'` in status `running`, or `queued` with its `run_started` already written, and pending input) and, when it returns a run id, `RunAbort.request(runId, null, { reason: "superseded" })` after the commit; return null as today.
- `ensureRunIn`: when the active run is a `queued` idle compact run with no `run_started` yet and input is pending, end it in the same transaction through `finisher.finishIn` (`status: "aborted"`, `run_aborted { byAccountId: null, reason: "superseded" }`) and continue the decision as if no run were active (the message's run is created in the same transaction). Any other active idle run with pending input: record it in `st.preempt` and return null; `ensureRun` sends the abort after the commit.
- Pending input: `newest user_message seq > consumed_seq`, or a queue head while the queue is not paused, or `wakeDecisionIn(...)?.kind === "wake"` (read only; a `later` decision owes nothing here).
- A manual compact run is never preempted (`compact_origin` other than `'idle'`).

- [ ] **Step 1: Write the failing tests** (model-fake holding the in-context summary call until released):
  - a message posted while the idle run is `running` → `run_aborted.reason: "superseded"`, no `compaction_summary`, then the message's run starts and completes; the message's run compacts inline only if over the trigger;
  - a message posted while the idle run is `queued` (worker paused through the existing `RUN_HOOKS` seam before the claim) → the idle run is aborted in the message's transaction and the message's run is the next run;
  - a finished background task that wakes the conversation preempts the same way; one inside its wake window does not;
  - a queued message (conversation queue) preempts and is not paused afterwards;
  - a message while a manual compact run is running does not preempt (the message waits, as today);
  - if the abort arrives after `compaction_summary` was written, the summary stands and the run ends aborted (spec §5.2).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the file, `test/runtime/queued-abort.test.ts`, `test/conversations/conversations.http.test.ts`, `test/background/wake.test.ts`, `test/conversations/queue.http.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(runtime): preempt an idle compaction when input arrives`.

### Task 9: Arming at run finish

High risk (multi-replica job lifecycle). Most capable model; reviewed alone.

**Files:**
- Create: `packages/kernel/src/runtime/idle-compaction-jobs.ts` (leaf: `IDLE_COMPACTION_JOB = "idle-compaction"`, `idleCompactionJobId(runId) = \`idle-compact-${runId}\``, `IdleCompactionJobData`, `oweIdleCompaction(outbox, data, runAt)`)
- Create: `packages/kernel/src/runtime/idle-arm.ts` (`IdleArm` provider: gathers `IdleArmFacts`, calls `idleArmDecision`)
- Modify: `packages/kernel/src/runtime/run-worker.ts` (the `max_duration` and default finish branches compute the intent and pass it)
- Modify: `packages/kernel/src/runtime/run-finish.ts` (`FinishRunArgs.idleCompaction?`; owe the row after the terminal event)
- Modify: `packages/kernel/src/infra/outbox/registry.ts` (`"idle-compaction"` entry)
- Modify: `packages/kernel/src/runtime/runtime.module.ts` (provide `IdleArm`)
- Test: create `packages/kernel/test/runtime/idle-arm.test.ts` (integration, one app, `OUTBOX_DISPATCH_FAILS` seam)

**Interfaces (produces):**

```ts
export interface IdleCompactionJobData {
  orgId: string; conversationId: string; runId: string;
  armedSeq: number;      // the run_finished seq (S4)
  cacheCallSeq: number;  // CacheExpiry.callSeq
  expiresAt: number;     // epoch ms
}
// FinishRunArgs.idleCompaction?: { orgId: string; cacheCallSeq: number; expiresAt: number; runAt: number }
// IdleArm.decide(run, conv, outcome): Promise<FinishRunArgs["idleCompaction"] | undefined>  (never throws)
```

Registry entry: `queue: "cap-kernel-maintenance"`, `processedIn: "packages/kernel/src/runtime/maintenance.ts"`, `idempotent`: "the job re-reads the conversation and starts at most one idle compact run under the conversation row lock, only while no event other than a run-less side-call usage follows armedSeq; a duplicate delivery finds the first delivery's run_started or its active compact run and does nothing", `opts: { attempts: 2, backoff: { type: "fixed", delay: 5_000 }, removeOnComplete: true, removeOnFail: true }`.

`IdleArm.decide` (outside any transaction; every failure → `warn` log, `undefined`): reads, cheapest first, stopping at the first failing fact (`debug` log with the skip reason): the run row (`automation_run_id`) and its `run_started.trigger`; effective settings (`CompactionSettingsService.resolve`); the owner's `idle_compaction`; the run's `model_call` and step `usage` events (types filtered, by `run_id`) → `deriveCacheExpiry` with `cacheOf` from `ModelRegistry.resolve` (its cached list); the last call's window from the same resolve; `inContextSummaryAllowed`; the run's events after its last `model_call` → `!unansweredAfterReply(...)`.

- [ ] **Step 1: Write the failing tests** (model-fake declared `[300, 3600]`, org `promptCache.longTtl` on, `compaction.idleMinTokensFloor: 50000`, `idleMinWindowRatio: 0.1`, model-fake `contextWindow: 400000`, a conversation built with about 220k characters of user text so the last call is ≥ 50k tokens; dispatch failing):
  - a completed message run owes one outbox row: queue `cap-kernel-maintenance`, name `idle-compaction`, job id `idle-compact-<runId>`, `org_id`, data `{ orgId, conversationId, runId, armedSeq: <run_finished seq>, cacheCallSeq, expiresAt }`, `run_at = t0 + 3240 s` (t0 = the call's `createdAt`), and the maintenance queue has no job;
  - nothing owed: `longTtl` off (5-minute default), a model-fake model scripted `cache: "none"`, a context under the threshold, a scheduled task's run, an `automation_event` run, a wake run with an automation lineage, a sub-agent conversation's run, a `budget` stop, `idleEnabled: false`, `enabled: false`, the owner's `idleCompaction: "off"`, a model-fake model outside the gate table (use a provider name other than `model-fake` through the test gate seam only if the table cannot be avoided; else skip this case and cover it in Task 4), a `max_steps` run ending with an unanswered tool result;
  - a failing `IdleArm` (registry throws) still finishes the run `completed` and owes nothing.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/idle-arm.test.ts` — FAIL. **Step 3: Implement.** **Step 4: Run** it, `test/infra/outbox.dispatcher.test.ts`, `test/runtime/run-worker.test.ts`, `test/runtime/run-queue-outbox.test.ts` — PASS; `pnpm check` (`kc-enqueue-via-outbox`, kernel conventions).
- [ ] **Step 5: Commit** `feat(runtime): owe an idle compaction job when a run finishes`.

### Task 10: Web settings, account preference and i18n

**Files:**
- Modify: `apps/web/src/components/settings/CompactionSection.tsx` (three fields; the two size fields disabled while `idleEnabled` is off; the org "follow the platform" state)
- Modify: `apps/web/src/lib/admin.ts`, `apps/web/src/lib/org-settings.ts`, `apps/web/src/lib/account-preferences.ts` (types)
- Modify: `apps/web/src/app/(app)/account/preferences/view.tsx` (a switch; read-only "组织已关闭" / "Off in your organization" when the org's effective `idleEnabled` is false)
- Modify: `apps/web/messages/en.json`, `apps/web/messages/zh.json` (all phase 2 keys, including Task 12's)
- Modify: `apps/web/test/compaction-settings.test.tsx`, `apps/web/test/account-preferences.test.tsx`

Copy (spec §6.4): `compaction.idleEnabled` "Compact idle conversations before the cache expires" / "缓存过期前在后台压缩", hint en "While a conversation is idle, compact it from the prompt cache before the cache expires, so the next message neither waits for a compaction nor re-reads the long context at full price. Only for models whose cache lasts 30 minutes or more (most need the long cache tier)." zh "对话空闲时，在模型的提示缓存过期前用缓存压缩，下次发消息时不必等待压缩，也不必全价重读长上下文。只对缓存至少 30 分钟的模型生效（大多数模型需要开启长缓存）。"; `compaction.idleMinTokensFloor` "Smallest context to compact in the background" / "后台压缩的最小上下文", help en "Compacts only when the context is at least the larger of this and the window share (default 200,000)." zh "上下文不少于这个数和窗口比例两者中较大者时才压缩（默认 200,000）。"; `compaction.idleMinWindowRatio` "Smallest context as a share of the window" / "按窗口比例的最小上下文", help en "Default 0.3: from 300,000 on a model with a 1M window." zh "默认 0.3：1M 窗口的模型从 300,000 起。"; preference "Compact my conversations while I'm away" / "空闲时压缩我的对话", org-off state "Off in your organization" / "组织已关闭". Conversation keys for Task 12: `conversation.compactingIdle` "Compacting in the background…" / "正在后台压缩会话…"; `conversation.compactedIdle` "Earlier conversation compacted while idle · saved {n} tokens" / "较早的会话已在空闲时压缩 · 节省 {n} tokens"; `conversation.compactedIdleHelp` "Turn this off in your account preferences." / "可以在账户偏好里关闭。".

- [ ] **Step 1: Write the failing tests** (`renderRouteWithCache`): the platform page shows the three fields with defaults; turning `idleEnabled` off disables the size fields and sends `PUT /admin/settings { compaction: { idleEnabled: false } }`; the org page follows the platform and saves an override; a member without the settings role sees the read-only state; the account preferences page sends `PUT /me/preferences { idleCompaction: "off" }` and `null`, and shows "Off in your organization" when the org has it off.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (reads through the existing `defineQuery`, writes through `useAppMutation`).
- [ ] **Step 4: Run** the two tests, `apps/web/test/admin-settings.test.tsx`, `apps/web/test/org-settings.test.tsx`; `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm check:web-api-parity` — PASS.
- [ ] **Step 5: Commit** `feat(web): idle compaction settings and account preference`.

### Task 11: The fire job

High risk (multi-replica job lifecycle). Most capable model; reviewed alone.

**Files:**
- Create: `packages/kernel/src/runtime/idle-compaction.ts` (`IdleCompactionJob` provider)
- Modify: `packages/kernel/src/runtime/maintenance.ts` (constructor `@Inject(IdleCompactionJob)`, `case IDLE_COMPACTION_JOB`, the class doc's job list)
- Modify: `packages/kernel/src/runtime/runtime.module.ts` (provide it)
- Create: `packages/kernel/test/runtime/idle-compaction.test.ts` (integration, one app)

**Interfaces (produces):**

```ts
@Injectable()
export class IdleCompactionJob {
  /** One delivery of `idle-compact-<runId>` (spec §4.3): gathers IdleFireFacts, decides, and starts
   *  the run through RunQueue.startIdleCompaction. Logs one `info` line, context=IdleCompaction. */
  fire(data: IdleCompactionJobData, now?: number): Promise<IdleFireOutcome | "started">;
}
```

Fact gathering order (cheap first, stop at the first failure, matching `idleFireDecision`'s order): conversation + org + agent rows; the neutral-event staleness query (`seq > armedSeq AND NOT (type = 'usage' AND run_id IS NULL)`, limit 1); active run / unconsumed message / queue head; settings + owner preference; `now` vs `expiresAt`; the latest `compaction_summary` / `compaction_failed` seqs; the effective definition (agent `current_version` → `normalizeStoredDefinition` → `effectiveDefinition` with `readSelection`) and its model resolved for the org vs the `cacheCallSeq` call's provider and model (`model.disabled` counts as `no_model`); only then `CompactionService.probeIdle` (reads all events and media). Start: `startIdleCompaction` null → `obsolete` if stale else `busy`. Log line fields: `outcome`, `orgId`, `conversationId`, `runId` (the arming run), `idleRunId` when started, `estimate`, `ttl`, `lateMs = now − runAt`.

- [ ] **Step 1: Write the failing tests** (the Task 9 setup; arm with dispatch failing, read the row's data, then):
  - happy path: clear the flag, set `run_at = now()` in SQL, `drainOutbox(app, { jobName: "idle-compaction" })` → an idle compact run with `compactOrigin: "idle"`, `compaction_summary.method: "in_context"`, a `usage` with `purpose: "compaction"` and `cacheReadTokens > 0`, `model.request` fired with purpose `compaction` (test hook extension), `triggerAccountId` = owner;
  - a second `fire(data)` afterwards → `obsolete`, no second run;
  - `obsolete` after a message; not obsolete after only a title job's `usage` (S1);
  - `busy` with a queue head; `disabled` after the org turns `idleEnabled` off; `expired` with `now = expiresAt − 30_000`; `backoff` after a `compaction_failed`; `no_model` after the agent's version changes the model (no event in the conversation); `small` after a summary already covers all but a few turns; `no_prefix` when the last call's request recorded a `fit` plan;
  - a policy hook denying the summary call → `compaction_failed`, the run `completed`, and the next armed job ends `backoff`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** it and `test/runtime/run-queue-outbox.test.ts` — PASS; `pnpm check` (kernel conventions: explicit `@Inject`, no in-process state).
- [ ] **Step 5: Commit** `feat(runtime): compact idle conversations before their cache expires`.

### Task 12: Web conversation page

**Files:**
- Modify: `apps/web/src/lib/timeline.ts` (the run record keeps `compactOrigin`; an idle run's `compaction_failed`, run failure and `run_aborted` draw nothing; its summary's divider is `{ divider: "compacted", idle: true, … }`)
- Modify: `apps/web/src/components/conversation/CompactingRow.tsx` (label `compactingIdle` when the progress's run is an idle compact run)
- Modify: `apps/web/src/components/conversation/Thread.tsx` (the idle divider text and its help line)
- Modify: `apps/web/test/timeline.test.ts`, `apps/web/test/compacting-row.test.tsx`

- [ ] **Step 1: Write the failing tests**: a timeline with an idle compact run that summarized shows one divider "Earlier conversation compacted while idle · saved 1,234 tokens" with the help line; a superseded idle run, a person-stopped idle run and a failed idle run add no entry (S10); a manual compact run keeps its dividers (`compact-failed`, `compact-stopped`); the compacting row reads "Compacting in the background…" for an idle run and "Compacting…" otherwise.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the tests, `apps/web/test/thread-process.test.tsx`; `pnpm check:web-ui` — PASS.
- [ ] **Step 5: Commit** `feat(web): show idle compactions quietly in the conversation`.

### Task 13: `idle_return` log

**Files:**
- Create: `packages/kernel/src/runtime/idle-return.ts` (pure `idleReturnFacts(...)` + the reader)
- Create: `packages/kernel/test/runtime/idle-return.test.ts` (unit for the pure part; add to `unit-tests.json`)
- Modify: `packages/kernel/src/runtime/run-worker.ts` (after a chat run's `run_started`, a non-compact run only; never throws)

Rule (S11): previous run = the latest finished non-compact run of the conversation; gap = this run's start − its `finished_at`; when gap > 30 min and that run's last step usage (`input + cacheRead + cacheWrite + output`) ≥ `idleMinTokens(W)`, log `info` `idle_return` (`context=IdleCompaction`) with `gapMs`, `contextTokens`, `threshold`, `ttl` (that run's last call: recorded `cacheTtl` else the declaration's `defaultTtl`, null when none), `idleSummary` (a `compaction_summary` in an idle compact run after that `finished_at`), `runId`.

- [ ] **Step 1: Write the failing unit tests** for `idleReturnFacts`: gap 29 min → none; gap 31 min with 250k on a 400k window → logged facts; with an idle summary in between → `idleSummary: true`; a 5-minute cache → `ttl: 300` (the opportunities the 30-minute rule leaves out).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (two indexed reads at run start: the previous run row, its last step `usage` event). **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(runtime): log returns to idle conversations`.

### Task 14: Replay and eval planning

**Files:**
- Modify: `packages/kernel/test/evals/reconstruct.test.ts` ("baseline zero drift")
- Modify: `packages/kernel/test/evals/plan.test.ts`

- [ ] **Step 1: Run the zero-drift baseline** — PASS.
- [ ] **Step 2: Write the cases**: an idle compact run's in-context summary followed by a message run reconstructs the message run's calls with empty drift; a preempted idle run (`run_aborted.reason: "superseded"`, no summary) followed by a run that compacted inline reconstructs with empty drift; eval planning skips the idle compact run (`trigger: "compact"`, `compactOrigin: "idle"`).
- [ ] **Step 3: Run** both files — PASS (they pass without product changes when Tasks 3–11 are right; a failure is a product bug to fix in its task's file).
- [ ] **Step 4: Commit** `test(evals): replay conversations with idle compactions`.

### Task 15: Container tests (two replicas)

High risk. Most capable model; reviewed alone.

**Files:**
- Modify: `packages/kernel/test/conversations/compact.dual.test.ts` (already in `packages/kernel/test/container-tests.json`; no new list entry)

- [ ] **Step 1: Write the tests**:
  - the same `IdleCompactionJobData` fired concurrently on replica A and replica B (`a.app.get(IdleCompactionJob).fire(data)` and `b…` in `Promise.all`) → exactly one idle compact run and one `compaction_summary`; the other returns `obsolete` or `busy`;
  - an idle compact run held on replica B (model-fake holding the summary call; the run claimed by B's worker) and a message posted through replica A → B's run ends `run_aborted.reason: "superseded"`, the message's run completes, and the queue is not paused.
- [ ] **Step 2: Run** `pnpm exec vitest run --project container packages/kernel/test/conversations/compact.dual.test.ts` — PASS (they pass when Tasks 7, 8 and 11 are right).
- [ ] **Step 3: Commit** `test(runtime): idle compaction on two replicas`.

### Task 16: Restore the D7 copy, docs and changesets

**Files:**
- Modify: `apps/web/messages/en.json`, `apps/web/messages/zh.json` (the `promptCache.longTtl` hint gains en "Idle compaction runs on these models only with this on." and zh "开启后空闲压缩才会在这些模型上运行。", phase 1 decision D7)
- Modify: `apps/web/test/prompt-cache-settings.test.tsx` (the case "no mention of idle compaction" becomes: the hint ends with that sentence in en and zh)
- Modify: `docs/superpowers/specs/2026-11-14-context-compaction-design.md` (§4.7: a compact run may be an idle one; pointer to the idle spec)
- Create: `.changeset/idle-compaction.md` (`@capybara-hq/capybara`, `@capybara-hq/kernel`: idle compaction, the settings, the preference, the price note of the long tier)

- [ ] **Step 1:** Change the test first (FAIL), then the copy (PASS): `pnpm exec vitest run apps/web/test/prompt-cache-settings.test.tsx`; `pnpm check:i18n`.
- [ ] **Step 2:** `pnpm verify --fast` plus the changed tests; `pnpm check:api-changeset --base origin/main`.
- [ ] **Step 3: Commit** `feat(web): say that the long cache enables idle compaction` and `docs(idle-compaction): phase 2 notes and changeset`.

---

## Decision points (recommendations; the maintainer rules in the plan review)

- **D1 S5, automation lineage.** Recommend: a wake run whose `runs.automation_run_id` is set does not arm, and `automation_event` never arms. Alternative: follow §4.2 literally (wakes always arm), costing background calls on conversations nobody reads.
- **D2 S9, platform-level idle fields through the Platform tool.** Recommend: keep `admin.update-settings`' existing `compaction` omit (console-only, like every compaction field), document the fields on `org-settings.update` and the preference operation. Alternative: lift the omit for all compaction fields (a separate change with its own review).
- **D3 S10, a person's stop of an idle run.** Recommend: show nothing (an idle compaction stays quiet; the person stopped background work they did not start). Alternative: the manual "compaction stopped" divider.
- **D4 Arm-time quality gate and settled point (S7).** Recommend: check both at arm time (same outcomes, fewer owed jobs). No behaviour change, but the maintainer should know that `max_steps` and `max_output` runs then almost never arm.
- **D5 Default on with nothing qualifying.** `idleEnabled` defaults on (Q1), yet nothing fires until `longTtl` is on for a gated Sonnet / Qwen4-max line or an OpenAI model passes the gate (#1002). Recommend: ship as specified, say so in the release notes, and prioritize #1002 (OpenAI credits) since GPT-5.6+ is the only family that qualifies by default.
- **D6 Size floor in tests.** The settings floor is 50,000 (spec range), so integration tests build conversations of about 220k characters on model-fake. Recommend: keep the spec range (no test-only lower bound); the cost is a few hundred ms of fixture building per test file.

## AGENTS.md rules touched

- **Multi-replica discipline:** a delayed `idle-compaction` job owed through the outbox in the run-finish transaction (`idle-compact-<runId>`, no `:`), consumed by `MaintenanceProcessor` under `WorkerModule` inside `runJob` (org scope from `data.orgId`); no in-process timer or state; the expiry is derived from the log; the run starts under the conversation row lock; preemption through `RunAbort`; no network call (model registry) inside a transaction (Tasks 7, 8, 9, 11, 15).
- **Runtime and replay:** no new model-visible input, no `DriftReason`; zero-drift tests before and after Tasks 6, 7, 14; replay skill note (Task 3).
- **Migrations:** `0192_idle_compaction.sql`, additive, `IF NOT EXISTS`, no RLS change (`runs`, `accounts` have no `org_id`) (Task 1).
- **Config / settings:** three compaction fields in `DeploymentSettings` / org settings and a personal preference; not `KernelConfigSchema`, so `adding-config` does not apply (Tasks 2, 5).
- **Platform tool:** no new route; shared schemas; descriptions updated; parity test and `check:platform-ops` green (Tasks 2, 5).
- **Web UI / language:** design components only, i18n zh / en with 平台 / 智能体, no box in a box, settings sections as siblings (Tasks 10, 12, 16).
- **Tests:** new unit tests join `packages/kernel/test/unit-tests.json` (Tasks 4, 13); container tests extend `conversations/compact.dual.test.ts`, already in `packages/kernel/test/container-tests.json` (Task 15); integration one app per file.
- **Releases:** one changeset on `@capybara-hq/capybara` and `@capybara-hq/kernel` in `.changeset/` (Task 16); no plugins release.
