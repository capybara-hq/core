# Test portfolio design: fewer, better-placed, deterministic tests

- date: 2026-11-14
- status: approved by the maintainer, 2026-11-14; implementation plan:
  `docs/superpowers/plans/2026-11-14-test-portfolio.md`
- input: findings `governance-load` and `test-timeout-ladder` in
  `docs/reviews/2026-11-12-2-design-review.md`, plus this pass's measurements; the follow-up
  review report `docs/reviews/2026-11-14-design-review.md` is not merged yet
- scope: core, `packages/kernel` first; other packages explicitly later (see Scope boundary)

## Intent

CI wait is the felt pain: a kernel-touching PR takes ~13 minutes, and the test job is 6–9 of
them. The suite is large, integration-heavy, and timing-sensitive:

- 811 `.test.ts` files repo-wide; 578 under `packages/kernel/test` with **6,014 tests**. All
  TypeScript under `packages/kernel/test` is 235,463 lines against 195,983 source lines (1.2:1;
  only `*.test.ts` is 225,092).
- **239 of 578** kernel test files boot the whole Nest app (transitively, through helpers). In a
  measured shard (96 files, 340 s) those files were **82 files / 333 s — 98 % of the time**; the
  other 14 files took 7 s.
- **198 files hold ≤5 tests**; of those, **~137 boot an app or container** (the rest are pure
  unit tests and are fine small).
- Timeouts have three forms, not one: ~345 `timeout:` object properties (~268 on `describe`,
  ~8 on `it`), **~905 third-argument timeout closures** (`beforeAll(async () => …, 120_000)`),
  and a global 120 s `hookTimeout`; on top of a 5 s local / 30 s CI `testTimeout`.
- **166 fixed `sleep(<number>)`** calls against 999 condition waits; `setTimeout`-based waits are
  a further, uncounted form.
- There is no coverage tooling and no recorded baseline.

The intent is not "fewer tests for speed". It is: keep integration fidelity where behavior
actually emerges (database, queues, HTTP, extensions, replicas), stop paying for tests that buy
no guarantee, and make every addition follow a stated level policy so the suite does not regrow.

## Goals

| Id | Goal | Measure |
|---|---|---|
| G1 | Shorter CI without changing guarantees | kernel test shards 7–9 min → ≤5 min; total kernel PR wall ~13 → ≤9 min (test job only; e2e/docker untouched) |
| G2 | No app boot for a handful of tests | app- or container-booting files with ≤5 tests: ~137 → 0; pure unit files may stay small |
| G3 | Determinism | fixed waits of every kind (`sleep(n)`, `setTimeout(n)` promises) in tests → 0 outside an injected-clock exception; timeout overrides of every form → short documented lists in `vitest.config.ts` |
| G4 | A written level policy | policy in this spec + `AGENTS.md` pointer; new tests reviewed against it |
| G5 | No silent coverage loss | per-module line coverage recorded before T2 and after each batch; a drop needs an explicit decision in that PR |

## Non-goals

- Deleting tests merely to save time.
- Changing production code so tests get easier.
- Changing required checks, the full run on every push to `main`, or the PR diff plan.
- Replacing vitest, Playwright or Testcontainers.
- A coverage job in CI (merging shard reports is new CI wiring; see "Coverage method").
- Touching e2e / visual / docker jobs.

## Anti-goals (what would make this a failure even if the numbers improve)

- **A real regression ships** because a deleted test was the only guard for a behavior, and the
  full run on `main` catches it only after merge.
- A merged file leaks state between tests, turning one failure into many or hiding an ordering
  dependency that isolation used to expose.
- Coverage thresholds become the goal, so dead or duplicated tests stay alive to keep a number up.
- The policy is written and ignored; two months later the suite is back to 100 % app boots.

## Constraints

- 6,014 existing tests, one maintainer, public repository (standard Actions minutes are free).
- The full suite on every push to `main` stays the backstop; PRs keep running what the diff
  affects (`tools/ci/src/affected.ts`).
- Tests use real PostgreSQL, Valkey and the full Nest app; that is deliberate and stays.
- A merged file still starts at most one app; isolation between tests stays explicit.
- vitest is 5.0.x; the shard split is by file count (`FULL_SHARDS = 6`).

## Approaches considered

1. **Parallelism only** (more shards, duration-balanced split, docker split): zero semantic risk,
   ~13 → ~6 min, but local runs stay slow and the suite keeps growing. Deferred, not rejected:
   it composes with this design and can land later.
2. **File-level test selection** (`vitest --changed` after splitting the shared helper):
   rejected. 239/578 files boot the whole app, so 98 % of the time is in tests the import graph
   must always select. Selection cannot deliver without rewriting how those tests mount the app,
   which changes test fidelity.
3. **Curated directory map / recorded-coverage map**: rejected. Both are unsound (curated rots,
   coverage is an under-approximation); they trade a quality guard for minutes.
4. **T1 mechanical convergence + T2 level policy and pruning**: chosen. T1 is verifiable
   test-by-test; T2 restores a deliberate shape instead of compensating around it.

**Decision: T1 first (mechanical, low risk, measurable), then T2 area by area (judgment, each
batch reviewed).** T1 alone buys roughly 15–20 % of test CPU; T2 targets the rest.

## Design

### 1. Level policy (what belongs where)

| Level | Runs | Holds |
|---|---|---|
| unit | no database, no HTTP, no queue, no app | pure functions, parsers, renderers, policy rules, schema validation, path/host matching |
| integration | real PG + Valkey, one app per file | cross-module behavior, HTTP contracts, permissions, transactions, queue and outbox flows |
| container | real processes or two replicas | only what cannot be observed single-replica: lock loss, leader election, shutdown, cross-replica delivery |
| e2e (Playwright) | full stack | a person's journeys only |

A test belongs at the lowest level that can observe the behavior. Assertions on internal call
order, private structure, log sentences, or exact internal operation counts are implementation
detail: keep them only when that detail *is* the contract, and otherwise move the assurance to
the behavior (usually an integration test).

### 2. Project membership and timeouts

Vitest projects are declared in `vitest.config.ts`:

- `unit`: includes the file list in `test/unit-tests.json` (checked in, reviewed); **no**
  `globalSetup`, `testTimeout: 5_000`, `hookTimeout: 10_000`.
- `integration`: the current `node` project minus the unit list and the container list;
  `globalSetup` (shared PG/Valkey), `testTimeout: 60_000`, `hookTimeout: 120_000`. (Raised from
  30 s during T1: converged integration tests keep internal waits of 30–40 s for legitimate
  terminal conditions, and a bound below them turns a slow CI host into a flake. 60 s still
  catches a hang, and no test may sit at its bound with zero headroom.)
- `container`: includes `test/*-container-tests.json` (the `.dual.test.ts` files, 42 files /
  88 tests, and process tests); `testTimeout: 240_000`, `hookTimeout: 300_000`. These tests run
  two replicas against real Redis and PostgreSQL and legitimately take 20–30 s (one measured
  case: 30 s), so the project timeout is an upper bound sized to the category — it costs nothing
  for a passing test and only delays the failure report of a hung one. Shortening it would force
  clock fakes into tests whose point is real cross-replica timing.
- The `design`, `plugin-client` and `web` projects are unchanged.

Membership is a checked-in list, not a naming convention or import detection: renaming 578 files
is churn, and detecting "boots an app" at config time is unreliable. Integration is the default
category: a new test belongs there unless it is added to the unit list in the same PR.

All per-test override forms (object property and third argument) are removed. Files that still
need a longer wait (the dual tests) get it from the `container` project, not from per-test
values. A short list of exceptions, each with a comment, may remain in `vitest.config.ts`.

### 3. T1 — mechanical convergence (per area, batched, no behavior change)

- **Merge small files.** App- or container-booting files in the same directory with ≤5 tests
  merge into one file that keeps every `describe` name and test body unchanged. A merged file
  holds at least 6 and at most ~25 tests and starts one app; a directory never becomes one
  monolithic file. Files kept small on purpose (separate process, separate environment,
  separate plugin fixture) are listed with a reason in the PR that does the merge.
- **No fixed sleeps.** Replace `sleep(n)` and `setTimeout(n)` promises with a condition wait
  (`waitFor`/`waitForEvent`) or an injected clock where the repo already provides one
  (`lock-clock`). A test that asserts "nothing happened" waits for a positive marker or asserts
  on recorded state, not on elapsed time. Genuine time assertions (scheduler ticks) move to the
  injected clock.
- **Timeouts** per "Project membership and timeouts" above.
- **Unit project without containers**: local runs of unit tests start no PostgreSQL/Valkey; this
  is the local payoff.

### 4. T2 — pruning (area by area, each batch its own PR)

Candidates, in order of confidence:

1. Tests that only assert a mock was called (`toHaveBeenCalled`) or an internal count/order.
2. Tests that assert a log sentence or an internal error string rather than a contract.
3. Behavior already covered by an integration test, re-tested at unit level with no additional
   branch coverage.
4. Tests of framework or third-party behavior (Nest wiring, Kysely, zod).

The four criteria above are approved up front; they are the deletion standard for every batch.
Each batch's PR description carries the complete deletion list (test file, test name, reason,
where it is still covered) and the coverage delta of the affected modules. When it is nowhere and
the behavior matters, the test stays; when a candidate looks like a contract rather than
implementation detail (an error code, a permission outcome, user-facing copy), it is flagged in
the list for an explicit confirmation before it is deleted. Batch order: `catalog`, `tools`,
`migrations`, `channels`, `runtime`, `extensions`, `infra`, then the rest.

### 5. Coverage method

`@vitest/coverage-v8` is added as a devDependency. The baseline is measured once, before T2, with
a documented command (one full run, `--coverage`), and per-module line coverage is recorded in
`docs/testing/coverage-baseline.md`. After each T2 batch the same command runs on the branch; the
affected modules' coverage is compared and the PR states the delta. This is a review guardrail
for now. The intended end state, chosen by the maintainer, is a hard gate: merge the six shards'
reports and fail a batch whose affected modules drop below the baseline. That needs a new CI job
and check, so it is a follow-up (see Out of scope) rather than part of this design. Running
coverage has no effect on normal test runs.

### 6. Enforcement

- `AGENTS.md` gains a short "Tests" bullet: the level policy, no fixed sleeps, no per-test
  timeouts, one app boot per file, a new unit or container test's list entry in the same change
  (integration is the default).
- A diff-scoped check (`check:test-portfolio`) flags in **changed** kernel test files:
  `sleep(<number>)`, `new Promise(… setTimeout(… <number> …))`, a `timeout:` property or
  third-argument timeout, an app-booting file with ≤5 tests, and a file booting the app more than
  once. It runs by diff on PRs (changed files only, `--base "$(git rev-parse HEAD^1)"`) and in
  full in `pnpm check`. Existing violations are grandfathered in a checked-in list until their
  T1/T2 batch lands.
- Every new check states its full/diff mode in its PR and in `tools/checks/README.md`.

### 7. Measurement and rollback

Before/after table recorded in the implementing PR: test count, files, app-booting files,
fixed waits, timeout overrides (all three forms), per-module coverage, CI per-job durations
(`gh run view`). Each T1/T2 batch is revertible on its own.

## Scope boundary

T1/T2 and the check cover `packages/kernel/test` only in this design. `apps/web`, `packages/design`,
`packages/plugin-client` and `tools/checks` tests keep their current rules: jsdom and Playwright
tests have legitimate timing waits, and their cost is not the CI bottleneck. Extending the policy
there is a separate decision after the kernel numbers land.

## Rollout

1. Projects and timeouts, unit list, coverage baseline, `check:test-portfolio` with the
   grandfather list.
2. T1 per area: merge small files, replace fixed waits, remove overrides; measure after each area.
3. T2 per area: proposal list, approval, PR, coverage delta.
4. Re-measure CI; decide then whether the parallelism work (deferred approach 1) is still needed.

## Resolved decisions

- The four T2 criteria are approved up front; each batch PR lists every deletion with its reason
  and the coverage delta, and contract-looking candidates are confirmed explicitly.
- Coverage is a review guardrail in this design; the maintainer wants a hard gate later, as a
  follow-up that merges shard reports.
- The 42 `.dual.test.ts` files (88 tests) keep the `container` project's longer timeouts, not
  per-test overrides.

## Out of scope (follow-ups)

- More shards / duration-balanced sharding (CI parallelism).
- Docker job split (api/web builds in parallel, smoke after).
- e2e shard count and scope.
- Local `pnpm verify` fast path for changed directories (advisory only, never a gate).
- Coverage merged across shards as a CI job — the hard gate the maintainer wants next.
