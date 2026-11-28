# Compaction Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, with the wave plan below (`wave-planned-subagent-development`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a kernel model purpose `compaction`: when an admin maps it, every conversation summary (proactive, reactive, hard guard, manual, idle) is written by that model through the transcript path, and idle compaction runs on it timed by idle duration; unmapped, behaviour is today's, byte for byte.

**Architecture:** `prepareCompaction` keeps planning against the conversation's model V (estimate, trigger, plan, tail budget, fit guard) and, once a plan exists, chooses the summarizer S through one helper (`chooseSummarizer`): the mapped model C when it resolves for the org and is eligible (§4.3), else V. The call part sends the transcript request to S (C's window sizes the chunks, the cap is `min(setting, C max, V max)`, the mapping's params are sent) and records `model` on `compaction_summary` / `compaction_failed`; usage and hooks name S. Idle compaction gains a second mode, `compaction_model`, chosen at arm time, owed through the same outbox row with `runAt = now + idleDelayMinutes`, persisted on the idle run's row and required again at fire time and at run start (never V, never cache mode).

**Tech Stack:** TypeScript, NestJS kernel, Kysely + plain SQL migrations, BullMQ, transactional outbox, zod event schemas, vitest (unit / integration / container projects), Next web app with `@capybara-hq/design`, changesets.

**Spec:** `docs/superpowers/specs/2026-11-28-compaction-model-design.md` (PR #1075, issue #1074), as amended by "Spec issues" below (Task 0). It extends the code of `docs/superpowers/plans/2026-11-28-idle-compaction-phase2.md` (idle compaction phase 2, merged); that plan's rulings S1–S14 and R13 still bind.

## Global Constraints

- Unmapped (no effective `compaction` target, or one the org cannot use) = today's behaviour: the same requests to V (`params: {}`, `summaryCap = min(setting, V max)`, the in-context path where the gate allows). The purpose is resolved only after the trigger passed and a plan exists, so a step that does not compact pays no extra read.
- A call-time failure on C (provider error, timeout, cut off twice, a policy denial) writes `compaction_failed` and never retries on V (Q1). A policy denial is never routed around.
- A configured, usable, eligible C always wins over the in-context summary (Q2): the in-context attempt skips with `InContextFallback` `"compaction_model"`.
- `MIN_COMPACTION_MODEL_CHUNK_TOKENS = 32_000`: C is eligible only if `compactionChunkSize(compactionInputBudget(Wc, Cmax, R), Cmax) >= 32_000`.
- `Cmax = min(compaction.maxOutputTokens, C.maxOutputTokens, V.maxOutputTokens)`; on the reactive path V is the overflowed rung (`opts.ref`).
- `idleDelayMinutes`: `z.number().int().min(5).max(1440)`, default **30** (Q5), used only in compaction-model mode.
- The idle compact run never falls back to V in compaction-model mode and never switches modes between arm, fire and run.
- No new model-visible input, no `DriftReason`. `compaction_summary.model`, `compaction_failed.model`, job `mode` and `runs.idle_mode` are not model-visible. Zero-drift file before and after Tasks 6 and 12: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts`.
- Multi-replica (AGENTS.md): the idle job stays the outbox row on `cap-kernel-maintenance`, job id `idle-compact-<runId>` (no `:`), consumed by `MaintenanceProcessor` under `WorkerModule` in `runJob` with `data.orgId`; no timer, no in-process state; the purpose is read from PG each time (`ModelPurposesService` caches nothing); nothing that may list a provider's models (the purpose resolve, the registry) runs inside a transaction.
- Migrations: plain SQL, `IF NOT EXISTS`, next free number on `origin/main` when the task starts (**0199** today: `0198_acceptance_prompt.sql` is the last; re-check with `git ls-tree --name-only origin/main packages/kernel/src/migrations/ | tail -1` right before opening the PR). `runs` has no `org_id`: no RLS policy.
- Model-facing text: none added. UI text through i18n zh and en; zh says 平台 / 智能体 / 超级管理员, never 企业 or the Latin word `agent` (`pnpm check:i18n`). apps/web writes no styles, design components only (`pnpm check:web-ui`), sections stay siblings, no box in a box.
- Tests: no new unit test files (the pure changes extend `runtime/context/compaction.test.ts` and `runtime/context/idle-compaction-rules.test.ts`, already in `packages/kernel/test/unit-tests.json`); the container case extends `conversations/compact.dual.test.ts` (already in `container-tests.json`); new integration files are one app each. No fixed sleeps, no per-test timeouts.
- Platform tool: no new route, no new exclusion. `platform-parity.test.ts`, `pnpm check:platform-ops` green; the `org-settings.update` description gains the field.
- Changesets in `.changeset/<name>.md` (never `.changeset/pre/`): `@capybara-hq/kernel` and `@capybara-hq/capybara` (fixed with `@capybara-hq/web`). No SDK or plugin-client API change, no plugins release.

## Decisions (open questions Q1–Q5, decided as the spec recommends)

- **Q1 no call-time retry on the conversation model.** Resolution-time fallback only (§4.2); a failed C call writes `compaction_failed` and its backoff; revisit if prod logs show C outages causing trims.
- **Q2 a configured compaction model always wins over in-context.** One summarizer per org.
- **Q3 no explicit org "use the conversation's model" override.** An org disables the default's model or provider in the org instead (the effective target is then unconfigured there).
- **Q4 no hard quality gate.** The purposes hint asks for a tested model; the changeset / release notes list the measured transcript recall (spec §1 table, naming `gpt-5-nano` at 19.6% as the risk).
- **Q5 `idleDelayMinutes` default 30.**

## Current code (verified on `origin/main` 18bee3749)

| Claim | Where |
|---|---|
| Nine kernel purposes; `web_fetch` is the fourth | `packages/kernel/src/models/purposes.ts:63-102` |
| `resolve` throws `model.unconfigured` for unmapped / disabled / unavailable / wrong kind; returns the mapping on `ProviderListError` | `models/purposes.ts:478-507` |
| `chat` sanitizes the mapping's params against the target | `models/purposes.ts:572` |
| The summarizer is `opts.ref ?? input.agent.model` | `runtime/model-call.ts:1549` |
| `summaryCap = min(setting, info.maxOutputTokens)` (V's) | `runtime/model-call.ts:1614` |
| `CompactOptions.requireInContext` | `runtime/model-call.ts:1314-1319` |
| `InContextFallback` | `runtime/model-call.ts:1337-1361` |
| `PreparedCompaction` (`provider`, `info`, `ref` = V) | `runtime/model-call.ts:1500-1518` |
| Hook base, chunk budget, request, idle timeout, usage all from V's `ref` / `info` | `runtime/model-call.ts:1781-1800`, `:1880`, `:1910`, `:2025-2038` |
| `compaction_summary` payload written | `runtime/model-call.ts:2098-2114` |
| Every path goes through `prepareCompaction`: proactive `:801`, reactive / fit fix-up `:2298-2303`, `:2380-2385`, compact runs via `CompactionService` | `runtime/model-call.ts`, `runtime/compaction.service.ts:99-153` |
| `buildCompactionRequest` hard-codes `params: {}` | `runtime/context/compaction.ts:755-779` |
| `compactionInputBudget`, `compactionChunkSize`, `MIN_COMPACTION_CHUNK_TOKENS = 256` | `runtime/context/compaction.ts:101`, `:148`, `:159` |
| `ModelStepDeps` has no purposes service | `runtime/model-call.ts:228-300`; built in `runtime/run-steps.ts:75-115` |
| Full-run replays copy the step deps minus a deny list | `evals/worker.ts:132-159` |
| `COMPACTION_FIELDS` / defaults / merges | `identity/settings.ts:205-270`, `:1140-1150` |
| Arm and fire rules (cache only) | `runtime/context/idle-compaction-rules.ts:45-168` |
| `IdleArm.decideOrSkip` reads calls, then expiry, then gate | `runtime/idle-arm.ts:131-268` |
| `IdleCompactionIntent`, job owed in `finishIn` | `runtime/run-finish.ts:41-56`, `:211-232` |
| `IdleCompactionJobData` (cache fields) | `runtime/idle-compaction-jobs.ts:16-43` |
| Fire checks 5, 7, 8–9 | `runtime/idle-compaction.ts:190-194`, `:209-236`, `:243-255` |
| Idle run start, worker compact path | `runtime/run-queue.ts:265-282`, `runtime/run-worker.ts:1090-1176` (origin `:1114`) |
| `runs.compact_origin` (0195) | `db/kernel-schema.ts:673-682` |
| Web loading list of nine, hints map | `apps/web/src/app/(app)/admin/models/view.tsx:84-100`, `apps/web/src/components/PurposeEditor.tsx:50-71` |
| Compaction settings section and copy | `apps/web/src/components/settings/CompactionSection.tsx:89-110`, `apps/web/messages/en.json:3043-3078`, `zh.json:3031-3066` |
| `org-settings.update` description enumerates compaction fields | `packages/kernel/src/platform/ops/org-settings.ops.ts:56` |
| model-fake: window default 32,000, `maxOutputTokens` 4,096 for every model | `plugins/model-fake/src/script.ts:566-567` |

## Review Focus

1. **A policy denial of C's request never reaches V.** The denial writes `compaction_failed` (with `model: C`), no request to V follows in that compaction, and the step continues as today. Test in Task 11.
2. **Unmapped is byte-for-byte today.** With no mapping, the summary request to V equals today's (`params: {}`, cap `min(setting, V max)`), the in-context path still runs on a gated model, and `compaction_summary` differs only by `model: V`. Test in Task 6 plus the zero-drift file.
3. **A C the org cannot use mid-life.** Disabled in the org after mapping → inline compactions use V; an armed compaction-model idle job ends `no_model` and an idle run already queued writes nothing. Tests in Tasks 10 and 9.
4. **A large-output C never writes a longer summary than V would.** `deepseek-flash` declares 393,216 output tokens: the cap stays `min(setting, V max)`. Unit test in Task 5, request assertion in Task 6.
5. **A late compaction-model job still runs; a late cache-mode job still expires.** Worker backlog of hours: compaction-model mode has no `expired`. Unit test in Task 5, integration in Task 10.

---

## Spec issues found against the code (resolutions proposed; Task 0 writes them into the spec)

"Behaviour" marks a resolution that changes what the spec says the product does; the rest only fix the mechanism.

| # | Spec text | What the code says now | Proposed resolution | Behaviour? |
|---|---|---|---|---|
| C1 | §6.3: a `compaction_model` idle run "requires C" and never switches to cache mode | the idle run is inserted by `RunQueue.startIdleCompaction` (`run-queue.ts:265`) and executed later by the run worker, which knows only `runs.compact_origin` (`run-worker.ts:1114`); the job's `mode` never reaches the worker | migration 0199 adds `runs.idle_mode text NULL CHECK (idle_mode IN ('cache', 'compaction_model'))`; `startIdleCompaction(conversationId, armedSeq, mode)` writes it; the worker passes it to `CompactionService.force` | no |
| C2 | §6.1: compaction-model mode when "the purpose resolves to a usable C at arm time" | eligibility (§4.3) is decided per compaction; an ineligible C makes every inline compaction fall back to V | arm in compaction-model mode only when C is usable **and eligible** against V = the last call's model and the effective settings (the same `chooseSummarizer` the compaction uses); otherwise cache mode | **yes** (small): an ineligible C leaves idle compaction in cache mode instead of owing jobs that can only end `no_model` |
| C3 | §6.3 cache mode "keeps today's in-context-or-nothing"; §4.4 / Q2 C always wins | a C configured after a cache-mode job was armed makes `prepareCompaction` skip the in-context build (`compaction_model`) | the cache-mode probe then reports `inContext: false` → the job ends `no_prefix`, nothing written; the next finished run arms in compaction-model mode | **yes** (edge the spec leaves open): no background call the job was not armed for |
| C4 | §6.2 `runAt = finishedAt + idleDelayMinutes × 60 s` | the arm decision runs in the worker just before `RunFinish.finish` (phase 2 S4), so `finished_at` is not known yet | `runAt = now + idleDelayMinutes × 60_000` with `now` taken in `IdleArm.decide` (milliseconds before the finish) | no |
| C5 | §6.2 job data gains `mode` | jobs owed by the previous release may still be in the outbox or queue across the deploy | the consumer reads `data.mode ?? "cache"` (deploy window only; every new row carries `mode`) | no |
| C6 | §6.3 check 7 in compaction-model mode: "V resolvable" | cache mode compares the effective definition's model with the armed call (`idle-compaction.ts:224`); compaction-model mode has no armed call | compaction-model mode: the effective definition's model resolves for the org **and** `chooseSummarizer` returns C; a model switch since arming does not end the job (the probe sizes against the new V) | no |
| C7 | §4.2 resolves through `ModelPurposesService.resolve` "in `prepareCompaction`" | `ModelStepDeps` has no purposes service (`model-call.ts:228-300`); test stubs and step replays build their own deps | new optional dep `compactionModel?: CompactionModelPort` (absent = unmapped); `RunSteps` provides it; full-run replays inherit it through `replayLoopDeps` and resolve C through the billed replay registry (spec §7.3: the org's mapping at replay time) | no |
| C8 | §4.5 the summary call sends the mapping's params | `buildCompactionRequest` hard-codes `params: {}` (`compaction.ts:777`) | `buildCompactionRequest(..., opts: { retry?; params? })`, default `{}` | no |
| C9 | §6.3 "Progress shows from the plan on" | `hooks.planned` fires right after the plan (`model-call.ts:1611`) | the summarizer is chosen right after the plan and before `hooks.planned`, so a compaction-model idle run whose C is gone ends before any progress row | no |

---

## Wave plan

Risk per `wave-planned-subagent-development`: `high` = migration, request building / trust boundary (policy hooks, data sent to another provider), multi-replica job lifecycle, the run-start path. `high` tasks are reviewed alone on the most capable model; `normal` tasks of a wave share one batched review.

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 0 Spec amendments C1–C9, Q1–Q5 | — | spec only | normal | W1 | batched |
| 1 Migration `runs.idle_mode` | — | `migrations/0199_runs_idle_mode.sql`, `db/kernel-schema.ts`, `test/migrations/0199.test.ts` | high (migration) | W1 | alone, most capable |
| 2 `idleDelayMinutes` setting | — | `identity/settings.ts`, `platform/ops/org-settings.ops.ts`, `apps/web/src/lib/compaction.ts` (type only), settings tests | normal | W1 | batched |
| 3 The `compaction` purpose | — | `models/purposes.ts`, `test/models/purposes.test.ts` | normal | W1 | batched |
| 4 Event fields `model` | — | `conversations/events.ts`, `test/conversations/events.test.ts`, `.agents/skills/replay-evals/SKILL.md` | normal | W1 | batched |
| 5 Pure rules | 2 | `runtime/context/compaction.ts`, `runtime/context/idle-compaction-rules.ts`, their unit tests, `runtime/idle-arm.ts` + `runtime/idle-compaction.ts` (PASSING defaults only) | normal | W2 | batched |
| 7 Web | 2, 3 (HTTP shapes) | `PurposeEditor.tsx`, `admin/models/view.tsx`, `CompactionSection.tsx`, `admin/settings/view.tsx`, `lib/compaction.ts`, `messages/{en,zh}.json`, web tests | normal | W2 | batched |
| 6 Compaction core: summarizer choice | 3, 4, 5 | new `runtime/compaction-model.ts`, `runtime/model-call.ts`, `runtime/context/compaction.ts` (`buildCompactionRequest`), `runtime/compaction.service.ts`, `runtime/run-steps.ts`, `runtime/runtime.module.ts`, `test/runtime/model-call.test.ts` | high (request building, trust boundary) | W3 | alone, most capable |
| 8 Arming + job data | 5, 6 | `runtime/idle-arm.ts`, `runtime/run-finish.ts`, `runtime/idle-compaction-jobs.ts`, `runtime/idle-compaction.ts` (narrowing only), `test/runtime/idle-arm.test.ts` | high (multi-replica job lifecycle) | W4 | alone, most capable |
| 9 Idle run start + worker | 1, 6 | `runtime/run-queue.ts`, `runtime/run-worker.ts`, `test/conversations/compact.http.test.ts` | high (run start) | W4 | alone, most capable |
| 11 Chat-path integration tests | 6 | new `test/runtime/compaction-model.test.ts` | normal | W4 | batched |
| 10 The fire job | 5, 6, 8, 9 | `runtime/idle-compaction.ts`, `test/runtime/idle-compaction.test.ts` | high (multi-replica job lifecycle) | W5 | alone, most capable |
| 12 Replay | 6, 10 | `test/evals/reconstruct.test.ts` | normal | W6 | batched |
| 13 Container test | 8, 9, 10 | `test/conversations/compact.dual.test.ts` | high (multi-replica) | W6 | alone, most capable |
| 14 Docs and changeset | all | compaction spec §6, idle spec §6, `.changeset/compaction-model.md` | normal | W6 | batched |
| — PR | all | | | | final whole-branch review (most capable) |

Shared-file rules:

- `runtime/idle-compaction.ts`: Task 5 (the `PASSING` object gains the new facts' passing values), Task 8 (narrow `IdleCompactionJobData` on `mode`; a `compaction_model` job ends `no_model` until Task 10), Task 10 (the real checks). W2, W4, W5.
- `runtime/idle-arm.ts`: Task 5 (`PASSING`), Task 8 (the mode). W2, W4.
- `runtime/context/compaction.ts`: Task 5 (cap, eligibility), Task 6 (`buildCompactionRequest` params). W2, W3.
- `apps/web/src/lib/compaction.ts`: Task 2 (the type field, if `check:web-api-parity` needs it), Task 7 (the rest). W1, W2.
- `runtime/compaction.service.ts`: Task 6 only; Task 9 consumes `force(input, origin, idleMode)`.

## Release sequencing

1. **One core PR** (`feat/compaction-model`, from `origin/main`), opened after W6, marked ready, final whole-branch review on the most capable model. No seam forces a split: the migration is additive, the web reads existing routes, and no published API changes. Body: `Refs #1074`, the decisions Q1–Q5, the spec issues C1–C9 as resolved, the measured-models table (Q4). Re-check the migration number against `origin/main` before opening it.
2. Main merges it; the next Version Packages PR publishes `@capybara-hq/kernel` and the images (`@capybara-hq/capybara`).
3. Main upgrades prod and local dev. Mapping a compaction model on prod (e.g. `deepseek-flash`) is the super admin's choice, not part of the release.

---

### Task 0: Spec amendments

**Files:**
- Modify: `docs/superpowers/specs/2026-11-28-compaction-model-design.md` (§4.2, §4.4, §6.1–§6.3, §7.1, §12)

- [ ] **Step 1:** For each of C1–C9 edit the cited section to state the resolution in the spec's voice; mark C2 and C3 "(behaviour, decided in the plan review)". Turn §12 into decisions: one bullet per Q1–Q5 as in "Decisions" above; §7.1 gains `runs.idle_mode` (C1).
- [ ] **Step 2:** `pnpm check:agent-docs` and `pnpm lint` — PASS.
- [ ] **Step 3: Commit** `docs(compaction): resolve the compaction model plan's spec issues`.

### Task 1: Migration `runs.idle_mode`

High risk (migration). Reviewed alone.

**Files:**
- Create: `packages/kernel/src/migrations/0199_runs_idle_mode.sql` (renumber if taken)
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`RunsTable.idle_mode`)
- Create: `packages/kernel/test/migrations/0199.test.ts` (the pattern of `migrations/0195.test.ts`)

**Interfaces (produces):** `RunsTable.idle_mode: ColumnType<IdleMode | null, IdleMode | null | undefined, IdleMode | null>` with `export type IdleMode = "cache" | "compaction_model"` exported from `db/kernel-schema.ts` (doc: "0199: an idle compact run's mode (compaction model spec §6.1); null on every other run").

- [ ] **Step 1: Write the failing test**: after migrating, `runs.idle_mode` exists (text, nullable); `'cache'`, `'compaction_model'` and null insert; `'other'` fails with a check violation; running the migrations twice is a no-op.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/migrations/0199.test.ts` — FAIL.
- [ ] **Step 3: Write the migration**:

```sql
-- Compaction model (compaction model spec §6.1): the mode of an idle compact run, decided when
-- its job was armed; null on every other run.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS idle_mode text NULL
  CONSTRAINT runs_idle_mode_check CHECK (idle_mode IN ('cache', 'compaction_model'));
```

- [ ] **Step 4: Run** the test, `pnpm check:org-filter`, `pnpm check` — PASS.
- [ ] **Step 5: Commit** `feat(kernel): add runs.idle_mode`.

### Task 2: `idleDelayMinutes` setting

**Files:**
- Modify: `packages/kernel/src/identity/settings.ts` (`COMPACTION_FIELDS`, `COMPACTION_SETTINGS`, `effectiveCompactionSettings`, the platform patch merge at `:1140-1150`)
- Modify: `packages/kernel/src/platform/ops/org-settings.ops.ts:56` (description)
- Modify: `packages/kernel/test/identity/settings.test.ts`, `packages/kernel/test/runtime/compaction-settings.test.ts`, `packages/kernel/test/orgs/settings.test.ts`, and the full-object assertions in `test/admin/admin.http.test.ts`, `test/orgs/orgs.http.test.ts`, `test/runtime/context/fixtures.ts` (they list every compaction field)

**Interfaces (produces):** `CompactionSettings.idleDelayMinutes: number` (default 30).

- [ ] **Step 1: Write the failing tests**: `COMPACTION_SETTINGS.parse({}).idleDelayMinutes === 30`; the patch rejects `4`, `1441`, `30.5`; `effectiveCompactionSettings(platform, { idleDelayMinutes: 90 })` is 90 with the platform's other fields; HTTP: `PUT /api/v1/admin/settings { compaction: { idleDelayMinutes: 60 } }` then `GET` returns 60 and the other compaction fields unchanged; the org patch `{ compaction: { idleDelayMinutes: 120 } }`, then `{ compaction: null }` follows the platform again.
- [ ] **Step 2: Run** the three settings test files — FAIL.
- [ ] **Step 3: Implement**; the description's compaction clause gains, after `idleMinWindowRatio? (0.1 to 0.9)`: `idleDelayMinutes? (5 to 1440; minutes after a run before an idle compaction when a compaction model is set)`, and `idleEnabled?` reads `(compact idle conversations in the background: after idleDelayMinutes with a compaction model, else before a cache of 30 minutes or more expires)`. The `admin.update-settings` `compaction` omit stays.
- [ ] **Step 4: Run** the tests, `pnpm exec vitest run tools/checks/test/platform-parity.test.ts`, `pnpm check:platform-ops`, `pnpm check:web-api-parity` — PASS (add only the type field in `apps/web/src/lib/compaction.ts` if parity needs it).
- [ ] **Step 5: Commit** `feat(settings): add the idle compaction delay`.

### Task 3: The `compaction` purpose

**Files:**
- Modify: `packages/kernel/src/models/purposes.ts` (`KERNEL_PURPOSES`, after `web_fetch`)
- Modify: `packages/kernel/test/models/purposes.test.ts` (the kernel list at `:157-162` and the listing case at `:166`)

- [ ] **Step 1: Write the failing tests**: the kernel purpose list is `eval, title, review, web_fetch, compaction, subagent_fast, …` with `{ purpose: "compaction", kind: "chat", label: { zh: "摘要压缩", en: "Compaction" } }` and no `requires`; `PUT /api/v1/admin/model-purposes/compaction` with a chat model of model-fake saves it and audits `model.purpose_mapped`; with an embedding model it is refused (kind); an org override then `GET …/model-purposes` shows default, override and effective; `GET …/model-purposes/availability` lists `compaction`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/models/purposes.test.ts` — FAIL.
- [ ] **Step 3: Implement** the entry with the spec §4.1 doc comment.
- [ ] **Step 4: Run** it, `platform-parity.test.ts`, `pnpm check:platform-ops` — PASS.
- [ ] **Step 5: Commit** `feat(models): add the compaction purpose`.

### Task 4: Event fields `model`

**Files:**
- Modify: `packages/kernel/src/conversations/events.ts:2122-2163` (`compaction_summary.model`, `compaction_failed.model`)
- Modify: `packages/kernel/test/conversations/events.test.ts`
- Modify: `.agents/skills/replay-evals/SKILL.md` (one bullet: `compaction_summary.model` / `compaction_failed.model` are not model-visible; a compaction-model summary is `method: "transcript"`)

- [ ] **Step 1: Write the failing test**: both events parse with `model: { provider: "p", model: "m" }`, and without it; `model: { provider: "p" }` fails.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `model: z.object({ provider: z.string(), model: z.string() }).optional()`, documented "the configured ref of the model that wrote the summary (compaction model spec §7.1): the compaction model, or the conversation's on the fallback path; not model-visible; absent before it" (failed: "whose call failed or was denied; absent when no call was built").
- [ ] **Step 4: Run** the test and the zero-drift file — PASS.
- [ ] **Step 5: Commit** `feat(conversations): record which model wrote a summary`.

### Task 5: Pure rules

**Files:**
- Modify: `packages/kernel/src/runtime/context/compaction.ts`, `packages/kernel/test/runtime/context/compaction.test.ts`
- Modify: `packages/kernel/src/runtime/context/idle-compaction-rules.ts`, `packages/kernel/test/runtime/context/idle-compaction-rules.test.ts`
- Modify: `packages/kernel/src/runtime/idle-arm.ts`, `packages/kernel/src/runtime/idle-compaction.ts` (only their `PASSING` objects: `mode: "cache"`, `now: 0`, `modelReady: true`)

**Interfaces (produces):**

```ts
// context/compaction.ts
export const MIN_COMPACTION_MODEL_CHUNK_TOKENS = 32_000;
/** Cmax (compaction model spec §5.1); `summarizerMax` omitted = V alone (today's cap). */
export function compactionSummaryCap(setting: number, conversationMax: number, summarizerMax?: number): number;
/** §4.3: chunkSize(B(window, cap, reserve), cap) >= MIN_COMPACTION_MODEL_CHUNK_TOKENS. */
export function compactionModelEligible(window: number, cap: number, reserve: number): boolean;

// context/idle-compaction-rules.ts
export type IdleMode = "cache" | "compaction_model";   // re-export of db/kernel-schema's
IdleArmFacts += { mode: IdleMode; now: number };      // settings already carries idleDelayMinutes
idleArmDecision(f): | { arm: true; mode: "cache"; runAt: number; expiresAt: number; cacheCallSeq: number }
                    | { arm: true; mode: "compaction_model"; runAt: number }
                    | { arm: false; reason: IdleArmSkip };
IdleFireFacts += { mode: IdleMode };  // `sameModel` renamed `modelReady`:
//   cache: the effective model resolves and equals the armed call's (today);
//   compaction_model: the effective model resolves and chooseSummarizer returns C (C6)
```

Rules. `idleArmDecision` in `compaction_model` mode: kind, trigger, automation, outcome, disabled, personal as today; `lastCall === null` → `small`; size as today; skips `no_cache`, `short_ttl`, `quality_gate`, `fit_plan`, `unsettled`; `runAt = now + settings.idleDelayMinutes * 60_000`. Cache mode unchanged. `idleFireDecision`: `expired` only when `mode === "cache"`; `no_model` from `modelReady`; `no_prefix` only when `mode === "cache"`.

- [ ] **Step 1: Write the failing tests**:
  - `compactionSummaryCap(20_000, 128_000)` = 20,000; `(20_000, 8_192)` = 8,192; `(20_000, 32_000, 393_216)` = 20,000; `(20_000, 4_096, 393_216)` = 4,096 (a large-output C never raises it); `(20_000, 128_000, 8_192)` = 8,192.
  - `compactionModelEligible(128_000, 20_000, 8_000)` true; `(1_048_576, 20_000, 8_000)` true; `(64_000, 20_000, 8_000)` false; at the floor: the smallest window `w` with `compactionChunkSize(compactionInputBudget(w, 4096, 8000), 4096) === 32_000` is eligible and `w - 1` is not.
  - arm, compaction-model mode: passes with `expiry: null`, with `ttl: 300`, with `inContextAllowed: false`, `fitPlan: true`, `settled: false`; `runAt === now + 30 * 60_000` with the default and `now + 5 * 60_000` with `idleDelayMinutes: 5`; still skips `trigger: "schedule"`, `automation`, `budget`, `disabled`, `personal_off`, and a 199k context on a 200k window (`small`); `lastCall: null` → `small`.
  - arm, cache mode: every existing case unchanged and `mode: "cache"` on the pass result.
  - fire, compaction-model mode: `now = expiresAt + 3_600_000` still fires (no `expired`); `inContext: false` still fires; `modelReady: false` → `no_model`; probe `growth: 19_999` → `small`. Cache mode: existing cases unchanged.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/context/compaction.test.ts packages/kernel/test/runtime/context/idle-compaction-rules.test.ts` — FAIL.
- [ ] **Step 3: Implement**; update the two `PASSING` objects so `pnpm typecheck` passes.
- [ ] **Step 4: Run** the two files, `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(runtime): add the compaction model cap, eligibility and idle mode rules`.

### Task 6: Compaction core — the summarizer choice

High risk (request building; trust boundary: policy hooks and the transcript sent to another provider). Most capable model; reviewed alone.

**Files:**
- Create: `packages/kernel/src/runtime/compaction-model.ts`
- Modify: `packages/kernel/src/runtime/model-call.ts` (`ModelStepDeps.compactionModel`, `CompactOptions`, `InContextFallback`, `PreparedCompaction`, `CompactionPrepareSkip`, `prepareCompaction`, `runCompaction`)
- Modify: `packages/kernel/src/runtime/context/compaction.ts` (`buildCompactionRequest` `params`)
- Modify: `packages/kernel/src/runtime/compaction.service.ts` (`force`, `probeIdle`)
- Modify: `packages/kernel/src/runtime/run-steps.ts` (inject `ModelPurposesService`, provide `compactionModel`)
- Modify: `packages/kernel/src/runtime/runtime.module.ts` (import `ModelsModule`; it imports no runtime module, `models/models.module.ts:21-30`)
- Test: `packages/kernel/test/runtime/model-call.test.ts`

**Interfaces (produces):**

```ts
// compaction-model.ts
/** The org's effective `compaction` mapping, or null when it is unconfigured there. */
export interface CompactionModelPort { target(orgId: string): Promise<PurposeTarget | null> }
/** Wraps ModelPurposesService.resolve(orgId, "compaction"): model.unconfigured → null, else rethrow. */
export function compactionModelPort(purposes: Pick<ModelPurposesService, "resolve">): CompactionModelPort;
export interface Summarizer {
  source: "compaction_model" | "conversation";
  ref: ModelRef; provider: BoundProvider; info: ModelInfo;
  params: Record<string, ParamValue>;   // sanitized against info.parameters; {} for "conversation"
  cap: number;                          // compactionSummaryCap(...)
}
export type SummarizerFallback = "unconfigured" | "compaction_model_unavailable" | "compaction_model_small";
/** §4.2 / §4.3: C when mapped, resolvable and eligible; else V with the reason (warn for unavailable,
 *  debug for small, nothing for unconfigured; context=Compaction). Never throws for C's failures. */
export async function chooseSummarizer(
  deps: Pick<ModelStepDeps, "compactionModel" | "registry" | "log">,
  orgId: string,
  conversation: { ref: ModelRef; provider: BoundProvider; info: ModelInfo },
  settings: Pick<CompactionSettings, "maxOutputTokens" | "reserveTokens">,
): Promise<{ summarizer: Summarizer; fallback?: SummarizerFallback }>;

// model-call.ts
ModelStepDeps.compactionModel?: CompactionModelPort;      // absent = unmapped (C7)
CompactOptions.requireInContext → CompactOptions.idle?: IdleMode;
//   "cache": today's requireInContext; "compaction_model": requires source "compaction_model",
//   else the compaction ends with nothing written (prepare returns { skipped: "no_compaction_model" })
InContextFallback |= "compaction_model";
PreparedCompaction: drop `provider`; `info`/`ref`/`window` stay V's; add `summarizer: Summarizer`;
  `summaryCap` = summarizer.cap
CompactionPrepareSkip |= { skipped: "no_compaction_model" };
buildCompactionRequest(transcript, model, maxOutputTokens?, opts?: { retry?: boolean; params?: Record<string, ParamValue> });

// compaction.service.ts
force(input, origin: CompactOrigin = "manual", idleMode: IdleMode = "cache"): Promise<ForcedCompaction>;
//   manual → { force: true, manual: true }; idle → { force: true, idle: idleMode }
probeIdle(input: IdleProbeInput, mode: IdleMode): Promise<IdleProbe | null>;   // null also for no_compaction_model
```

`prepareCompaction` order: resolve V, media, request, estimate, trigger / backoff, plan (all unchanged) → `chooseSummarizer` → `opts.idle === "compaction_model" && source !== "compaction_model"` → `{ skipped: "no_compaction_model" }` → `hooks.planned` (C9) → in-context: `{ skip: "compaction_model" }` when `source === "compaction_model"`, else `inContextSummary` as today. `runCompaction`'s call part uses only `summarizer` (`ref`, `provider`, `info.id`, `info.contextWindow` for the budget, `info.streamIdleTimeoutMs`, `params`, `cap`) for the request, the hooks, the usage events and the stream; `compaction_summary.model` and `compaction_failed.model` = `summarizer.ref` (absent on the `unavailable` path, which builds no call). `runCompaction` treats `no_compaction_model` like the other silent skips.

- [ ] **Step 1: Run the zero-drift baseline** — PASS (record it).
- [ ] **Step 2: Write the failing tests** in `model-call.test.ts` (stub `compactionModel` port; model-fake `fake-1` 400k as V, `fake-c` 200k as C; registry from the existing harness):
  - no port (or `target` → null): the summary request equals today's (`params: {}`, `maxOutputTokens` = `min(setting, 4096)`), the gated in-context path still runs on model-fake, and `compaction_summary.model` = V;
  - port → C: one transcript request to `fake-c` with `purpose: "compaction"`, the mapping's params sanitized (an undeclared key dropped), `maxOutputTokens` = 4096; `compaction_summary { method: "transcript", model: C }`; usage `{ provider/model: C, purpose: "compaction" }`; the in-context skip logged with `reason: "compaction_model"`; the plan (`coversUpToSeq`, `openingSeqs`) equals the plan without C;
  - port → C with `contextWindow: 32_000` (ineligible): V writes it, `debug` `compaction_model_small`;
  - port → C whose `registry.resolve` throws: V writes it, `warn` `compaction_model_unavailable`;
  - port throws a non-`unconfigured` error: the compaction fails as today (no silent V);
  - C's call fails (scripted error): `compaction_failed { model: C }`, no request to V;
  - reactive (`force`, `ref` = rung, `transcriptOnly`): the plan uses the rung's window, the call goes to C, the cap is `min(setting, rung max, C max)`;
  - `idle: "compaction_model"` with no port: no event, no progress update, `{ summarySeq: null, failed: false }`; with C: transcript on C; `idle: "cache"` with C mapped: no event (in-context skipped, C3);
  - existing `requireInContext` cases renamed to `idle: "cache"`, unchanged otherwise.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** in this order: `buildCompactionRequest` params; `compaction-model.ts`; deps + `RunSteps` + module; `prepareCompaction`; the call part; `force` / `probeIdle`.
- [ ] **Step 5: Run** `model-call.test.ts`, `test/conversations/compact.http.test.ts`, `test/runtime/context/current-turn-compaction.test.ts`, `test/runtime/permission-context-boundary.test.ts`, `test/runtime/idle-compaction.test.ts`, the zero-drift file — PASS; `pnpm check` (kernel conventions: explicit `@Inject`).
- [ ] **Step 6: Commit** `feat(runtime): summarize with the compaction model when one is set`.

### Task 7: Web — purpose, settings field, copy

**Files:**
- Modify: `apps/web/src/components/PurposeEditor.tsx:50-71` (`compaction: "hint.compaction"`), `apps/web/src/app/(app)/admin/models/view.tsx:84-100` (`LOADING_PURPOSES` gains `"compaction"` after `"web_fetch"`; comment "the kernel's ten")
- Modify: `apps/web/src/components/settings/CompactionSection.tsx` (an `idleDelayMinutes` `NumberField` after `idleMinWindowRatio`, disabled while `idleEnabled` is off), `apps/web/src/lib/compaction.ts`, `apps/web/src/app/(app)/admin/settings/view.tsx` (defaults)
- Modify: `apps/web/messages/en.json`, `apps/web/messages/zh.json`
- Modify: `apps/web/test/models.test.tsx`, `apps/web/test/compaction-settings.test.tsx`, `apps/web/test/prompt-cache-settings.test.tsx`

Copy:
- `models.purpose.hint.compaction`: zh and en exactly as spec §9.2.
- `compaction.idleDelayMinutes.label` 「空闲多久后压缩（分钟）」 / "Compact after idle for (minutes)"; `.help` exactly as spec §9.2.
- `compaction.idleEnabled.label` 「空闲时在后台压缩」 / "Compact idle conversations in the background"; `.hint` en "While a conversation is idle, compact it in the background, so the next message neither waits for a compaction nor re-reads the long context at full price. With a compaction model set, this runs after the idle delay below; without one, only before a prompt cache of 30 minutes or more expires (most models need the long cache tier)." zh 「对话空闲时在后台压缩，下次发消息时不必等待压缩，也不必全价重读长上下文。配置了摘要压缩模型时，在下面的空闲时长后压缩；未配置时，只在至少 30 分钟的提示缓存过期前压缩（大多数模型需要开启长缓存）。」
- `promptCache.longTtlHint`'s last sentence becomes en "Without a compaction model, idle compaction runs on these models only with this on." zh 「未配置摘要压缩模型时，开启后空闲压缩才会在这些模型上运行。」

- [ ] **Step 1: Write the failing tests** (`renderRouteWithCache`, zh and en): the purposes tab lists 「摘要压缩」 / "Compaction" with its hint and saves `PUT /api/v1/admin/model-purposes/compaction`; the loading state draws ten purpose sections; the settings page shows the delay field with 30, disabled while `idleEnabled` is off, and sends `PUT /admin/settings { compaction: { idleDelayMinutes: 60 } }`; the org page follows the platform and saves an override; the new `idleEnabled` and `longTtlHint` copy in both locales.
- [ ] **Step 2: Run** the three files — FAIL. **Step 3: Implement** (existing `defineQuery` reads, `useAppMutation` writes).
- [ ] **Step 4: Run** them, `apps/web/test/admin-settings.test.tsx`, `apps/web/test/org-settings.test.tsx`; `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm check:web-api-parity` — PASS.
- [ ] **Step 5: Commit** `feat(web): compaction model purpose and idle delay setting`.

### Task 8: Arming and the job data

High risk (multi-replica job lifecycle). Most capable model; reviewed alone.

**Files:**
- Modify: `packages/kernel/src/runtime/idle-arm.ts` (choose the mode after the calls are read; inject `ModelPurposesService` through `compactionModelPort`)
- Modify: `packages/kernel/src/runtime/run-finish.ts:41-56`, `:211-232` (`IdleCompactionIntent` union; owe with `mode`)
- Modify: `packages/kernel/src/runtime/idle-compaction-jobs.ts` (`IdleCompactionJobData` union)
- Modify: `packages/kernel/src/runtime/idle-compaction.ts` (narrow on `data.mode ?? "cache"`; a `compaction_model` job returns `no_model` until Task 10)
- Test: `packages/kernel/test/runtime/idle-arm.test.ts`

**Interfaces (produces):**

```ts
export type IdleCompactionIntent =
  | { orgId: string; mode: "cache"; cacheCallSeq: number; expiresAt: number; runAt: number }
  | { orgId: string; mode: "compaction_model"; runAt: number };
export type IdleCompactionJobData =
  | { orgId: string; conversationId: string; runId: string; armedSeq: number; mode: "cache"; cacheCallSeq: number; expiresAt: number }
  | { orgId: string; conversationId: string; runId: string; armedSeq: number; mode: "compaction_model" };
// readers: `data.mode ?? "cache"` (C5)
```

`IdleArm.decideOrSkip`: after the calls are read and V's info resolved, `chooseSummarizer(…, V = the last step call's model, settings)`; `source === "compaction_model"` → `known.mode = "compaction_model"` (C2), else `"cache"`; `known.now = Date.now()` (C4). Everything stays outside the transaction; any failure → `warn`, no job. The outbox registry entry's `idempotent` sentence is unchanged.

- [ ] **Step 1: Write the failing tests** (the existing setup: model-fake 400k, floor 50000, ratio 0.1, ~220k characters; dispatch failing; map `compaction` to model-fake `fake-c` with `contextWindow: 200_000`, `cache: "none"`):
  - with `longTtl` **off** and C mapped: one outbox row `idle-compact-<runId>` with data `{ orgId, conversationId, runId, armedSeq, mode: "compaction_model" }` (no `cacheCallSeq`, `expiresAt`) and `run_at` within a second of `finish + 30 min`; with `idleDelayMinutes: 5`, `+ 5 min`;
  - C mapped and a run ending with an unanswered tool result (`max_steps`): still owed (no settled check);
  - C mapped with `contextWindow: 32_000` (ineligible): cache mode decides (with `longTtl` off: nothing owed);
  - C disabled in the org: cache mode decides;
  - unmapped: every existing case unchanged, rows carry `mode: "cache"`;
  - still nothing owed with C mapped: `idleEnabled: false`, the owner's opt-out, a scheduled run, a context under the threshold;
  - `ModelPurposesService.resolve` throwing a database error: the run finishes `completed`, nothing owed.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/idle-arm.test.ts` — FAIL. **Step 3: Implement.**
- [ ] **Step 4: Run** it, `test/runtime/idle-compaction.test.ts`, `test/infra/outbox.dispatcher.test.ts`, `test/runtime/run-queue-outbox.test.ts` — PASS; `pnpm check` (`kc-enqueue-via-outbox`).
- [ ] **Step 5: Commit** `feat(runtime): arm idle compaction on the compaction model`.

### Task 9: Idle run start and the worker

High risk (run start path). Most capable model; reviewed alone.

**Files:**
- Modify: `packages/kernel/src/runtime/run-queue.ts:265-360` (`startIdleCompaction(conversationId, armedSeq, mode: IdleMode)`; the insert writes `idle_mode`)
- Modify: `packages/kernel/src/runtime/run-worker.ts` (the run select at `:478` gains `idle_mode`; `executeCompaction` passes `run.idle_mode ?? "cache"` to `force`)
- Test: `packages/kernel/test/conversations/compact.http.test.ts`

- [ ] **Step 1: Write the failing tests**: `startIdleCompaction(conv, armedSeq, "compaction_model")` with C mapped → the row has `idle_mode = 'compaction_model'`, `compact_origin = 'idle'`; the run completes with `run_started.compactOrigin: "idle"`, one `compaction_summary { method: "transcript", model: C }` and usage on C, the automatic plan (`keepRecentTurns`, never the manual one: the latest turns stay unsummarized); the same after the purpose is cleared between start and claim → no event but `run_started` / `run_finished`, status `completed`; `"cache"` → `idle_mode = 'cache'` and today's in-context run; a manual compact run has `idle_mode` null; a superseded abort of a compaction-model idle run ends as phase 2 asserts (no queue pause).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the file, `test/runtime/idle-preemption.test.ts`, `test/runtime/queued-abort.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(runtime): run idle compactions in their armed mode`.

### Task 10: The fire job

High risk (multi-replica job lifecycle). Most capable model; reviewed alone.

**Files:**
- Modify: `packages/kernel/src/runtime/idle-compaction.ts` (inject `ModelPurposesService`; checks by mode; `startIdleCompaction(…, mode)`)
- Test: `packages/kernel/test/runtime/idle-compaction.test.ts`

Checks in compaction-model mode: 1–4 and 6 unchanged; 5 skipped (no `expiresAt`; `lifetime` / `ttl` / `lateMs` logged only in cache mode); 7: the effective definition's model resolves for the org and `chooseSummarizer` returns C (C6); 8 via `probeIdle(input, "compaction_model")` (null → `small`); 9 skipped. The log line gains `mode`.

- [ ] **Step 1: Write the failing tests** (arm as in Task 8, read the row's data, set `run_at = now()`, `drainOutbox(app, { jobName: "idle-compaction" })`):
  - happy path: an idle compact run with `compactOrigin: "idle"`, `compaction_summary { method: "transcript", model: C }`, usage on C, `model.request` observed with `purpose: "compaction"` and `model` = C (hooks-probe), `triggerAccountId` = owner;
  - `fire(data, now = Date.now() + 6 * 3_600_000)` (six hours late) still starts;
  - the purpose cleared after arming → `no_model`, no run, no call to V; C disabled in the org → `no_model`;
  - the agent's model changed since arming (C6) → still starts and sizes against the new model;
  - a cache-mode job after C was mapped (C3) → `no_prefix`, nothing written;
  - `obsolete`, `busy`, `disabled`, `backoff`, `small` in compaction-model mode as in cache mode;
  - a data row without `mode` (C5) is handled as cache.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** it and `test/runtime/run-queue-outbox.test.ts` — PASS; `pnpm check`.
- [ ] **Step 5: Commit** `feat(runtime): fire idle compactions on the compaction model`.

### Task 11: Chat-path integration tests

**Files:**
- Create: `packages/kernel/test/runtime/compaction-model.test.ts` (integration, one app; model-fake `fake-1` 400k as the agent's model, `fake-c` 200k and `fake-small` 50k as compaction models; hooks-probe fixture)

- [ ] **Step 1: Write the tests**:
  - proactive: `compaction` mapped through `PUT /api/v1/admin/model-purposes/compaction`, a conversation driven over the trigger → `compaction_summary { method: "transcript", model: fake-c }`, usage on `fake-c` in `model_usage`, and the next step's calibration reads only step usage (its estimate equals the run without C);
  - the org override wins over the platform default; the default's model disabled in the org → V writes the summary (Q3 path);
  - a manual `POST …/compact` keeps the #990 plan (same `coversUpToSeq` as unmapped) on `fake-c`;
  - a reactive overflow on a fallback rung plans against the rung and summarizes on `fake-c`;
  - a chunked compaction on `fake-small` (window 50,000: eligible, chunk ≈ 35k) over a ~120k-token transcript: one usage per chunk with `chunk` / `chunks`, one summary;
  - **Review Focus 1**: hooks-probe denying `model.request` with `purpose: "compaction"` → `compaction_failed { model: fake-c }` naming the plugin, no `model.request` / usage for V with purpose `compaction` in that step, and the step's own request still goes out;
  - a sub-agent conversation compacts on `fake-c` too.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/compaction-model.test.ts` — PASS (they pass when Task 6 is right; a failure is a product bug fixed in Task 6's files).
- [ ] **Step 3: Commit** `test(runtime): compaction model on the chat paths`.

### Task 12: Replay

**Files:**
- Modify: `packages/kernel/test/evals/reconstruct.test.ts`

- [ ] **Step 1: Run the zero-drift baseline** — PASS.
- [ ] **Step 2: Write the cases** (spec §7.3): a proactive compaction on a compaction model followed by a step reconstructs with empty drift; a chunked one on a small-window C likewise; an idle compaction in compaction-model mode followed by a message run likewise; a conversation on a gated model whose compaction became `transcript` because C was mapped reconstructs with the transcript framing sentence (from the logged `method`).
- [ ] **Step 3: Run** the file — PASS (no product change expected).
- [ ] **Step 4: Commit** `test(evals): replay compactions written by a compaction model`.

### Task 13: Container test

High risk (multi-replica). Most capable model; reviewed alone.

**Files:**
- Modify: `packages/kernel/test/conversations/compact.dual.test.ts`

- [ ] **Step 1: Write the test**: the same compaction-model `IdleCompactionJobData` fired concurrently on replica A and B → exactly one idle compact run (`idle_mode = 'compaction_model'`) and one `compaction_summary { model: C }`; the other returns `obsolete` or `busy`.
- [ ] **Step 2: Run** `pnpm exec vitest run --project container packages/kernel/test/conversations/compact.dual.test.ts` — PASS.
- [ ] **Step 3: Commit** `test(runtime): compaction-model idle compaction on two replicas`.

### Task 14: Docs and changeset

**Files:**
- Modify: `docs/superpowers/specs/2026-11-14-context-compaction-design.md` (§6: the deferred `compaction` purpose now exists; pointer to the compaction model spec)
- Modify: `docs/superpowers/specs/2026-11-27-idle-compaction-design.md` (§6.1: the "no delay field" ruling holds for cache mode only; pointer)
- Create: `.changeset/compaction-model.md` (`@capybara-hq/kernel`: patch; `@capybara-hq/capybara`: patch): the purpose, the idle mode and `idleDelayMinutes`, the data-residency note (the transcript goes to the compaction model's provider), and the measured transcript recall of spec §1 (Q4), naming `gpt-5-nano` as unsuitable.

- [ ] **Step 1:** Edit the docs; write the changeset.
- [ ] **Step 2:** `pnpm verify --fast` plus the changed tests; `pnpm check:api-changeset --base origin/main` — PASS.
- [ ] **Step 3: Commit** `docs(compaction): compaction model notes and changeset`.

---

## AGENTS.md rules touched

- **Model providers:** a kernel purpose `compaction` (kind `chat`); unmapped or unusable → the conversation's model; calls carry the org's mapping and its sanitized params; no model-provider@2 change (Tasks 3, 6).
- **Runtime and replay:** `compaction_summary.model`, `compaction_failed.model` additive, not model-visible; no `DriftReason`; zero-drift cases (Tasks 4, 6, 12).
- **Extensions (hooks):** `model.request` fires for every compaction-model call with C's ref; policy hooks fail closed and a denial never falls back (Tasks 6, 11).
- **Multi-replica discipline:** the idle job stays the outbox row with the deterministic id, `runJob` under `WorkerModule`, the row lock; the mode lives in the job data and `runs.idle_mode`, never in memory; no registry or purpose read inside a transaction (Tasks 8, 9, 10, 13).
- **Migrations:** `0199_runs_idle_mode.sql`, additive, `IF NOT EXISTS`, no RLS change (`runs` has no `org_id`) (Task 1).
- **Config / settings:** one compaction field `idleDelayMinutes` in deployment / org settings; not `KernelConfigSchema`, so `adding-config` does not apply (Task 2).
- **Platform tool:** no new route; the shared schemas and the `org-settings.update` description; parity green (Tasks 2, 3).
- **Web UI / language:** design components only, i18n zh / en with 平台 / 智能体 (Task 7).
- **Tests:** no new unit or container list entries; new integration file one app (Tasks 5, 11, 13).
- **Releases:** changeset on `@capybara-hq/kernel` and `@capybara-hq/capybara` (Task 14).
