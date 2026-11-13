# Test Portfolio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut kernel CI test time without losing a guarantee: split the kernel suite into unit / integration / container projects, remove fixed waits and per-test timeouts, merge small app-booting test files, and prune tests that assert implementation detail — per area, with a coverage baseline and a check that stops the suite regrowing.

**Architecture:** Three vitest projects over the same `packages/kernel/test` tree, membership from two checked-in JSON lists (`unit-tests.json`, `container-tests.json`; integration is the remainder). A new diff-scoped check (`check:test-portfolio`) flags fixed waits, timeout overrides, small app-booting files and double boots in changed test files, with a checked-in grandfather list that shrinks area by area. T1 is mechanical and test-count-preserving; T2 deletes only what the approved criteria cover.

**Tech Stack:** TypeScript, vitest 5.0.x (`--project`, `--coverage` with `@vitest/coverage-v8`), oxc-parser through `@capybara-hq/plugin-tools/source`, tsx CLIs, biome.

**Spec:** `docs/superpowers/specs/2026-11-14-test-portfolio-design.md`

## Global Constraints

- Scope is `packages/kernel/test` only; `apps/web`, `packages/design`, `packages/plugin-client` and `tools/checks` tests keep their rules.
- No production code changes; no test may change what it asserts during T1.
- The full suite still runs on every push to `main`; `tools/ci/src/affected.ts` is unchanged.
- Tests keep real PostgreSQL, Valkey and the full Nest app.
- T1 must preserve the collected test count: 6,014 kernel tests before and after.
- English for comments, identifiers and commit messages; Conventional Commits, body lines ≤ 100 characters.
- Run vitest from the repository root (`pnpm exec vitest run <path>`).
- Memory rule from the repo: `pnpm verify` before pushing; flaky tests are fixed, never retried.

## Review Focus

- A test file listed in both `unit-tests.json` and `container-tests.json` runs twice or not at all — the check must refuse an overlap and a missing path.
- A "unit" test that transitively needs PostgreSQL/Valkey fails only at run time in CI — Task 1 fixes classification by running the unit project, not by trusting the import rule.
- A merged file leaks state between describes (module-level `let`, shared container), turning one failure into many — every merge keeps `beforeEach`/`afterEach` pairs inside their describes.
- A grandfathered file stays exempt after its area was cleaned, so a later regression enters unflagged — each area batch deletes its baseline entries and the final state is an empty list.
- The check's diff mode runs on a non-merge checkout (`HEAD^1` missing) and must skip like `check:applied-migrations` instead of failing.

---

### Task 1: Kernel test projects and category lists

**Files:**
- Create: `packages/kernel/test/unit-tests.json`
- Create: `packages/kernel/test/container-tests.json`
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: projects named `kernel-unit`, `kernel-integration`, `kernel-container`; two JSON arrays of paths relative to `packages/kernel/test` (for example `"agents/template-limits.test.ts"`), imported by `vitest.config.ts` with `readFileSync` + `JSON.parse`.

- [ ] **Step 1: Generate the initial container list**

Run from the repository root:

```bash
node -e '
const fs=require("fs"),path=require("path");
function walk(d,acc=[]){for(const e of fs.readdirSync(d)){const p=path.join(d,e);const s=fs.statSync(p);if(s.isDirectory())walk(p,acc);else if(p.endsWith(".test.ts"))acc.push(p);}return acc;}
const root="packages/kernel/test";
const out=walk(root).filter(f=>f.endsWith(".dual.test.ts")||/(spawn|fork)\(/.test(fs.readFileSync(f,"utf8"))).map(f=>f.slice(root.length+1)).sort();
fs.writeFileSync(root+"/container-tests.json",JSON.stringify(out,null,2)+"\n");
console.log(out.length);
'
```

Expected: about 49 paths (42 `.dual.test.ts` plus process tests); review the list before committing.

- [ ] **Step 2: Generate the initial unit list**

```bash
node -e '
const fs=require("fs"),path=require("path");
function walk(d,acc=[]){for(const e of fs.readdirSync(d)){const p=path.join(d,e);const s=fs.statSync(p);if(s.isDirectory())walk(p,acc);else if(p.endsWith(".test.ts"))acc.push(p);}return acc;}
const root="packages/kernel/test";
const container=new Set(JSON.parse(fs.readFileSync(root+"/container-tests.json","utf8")));
const out=walk(root).map(f=>f.slice(root.length+1)).filter(p=>!container.has(p)&&!/(startTestPostgres|startTestRedis|buildKernel|startKernel|createDualReplica)/.test(fs.readFileSync(path.join(root,p),"utf8"))).sort();
fs.writeFileSync(root+"/unit-tests.json",JSON.stringify(out,null,2)+"\n");
console.log(out.length);
'
```

Expected: roughly 185 paths. This list is a starting point, not a verdict: Step 6 moves anything that fails without containers.

- [ ] **Step 3: Write the failing test**

Create `packages/kernel/test/portfolio.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const list = (name: string): string[] =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")) as string[];

describe("test portfolio lists", () => {
  it("lists unit and container tests with no overlap", () => {
    const unit = new Set(list("unit-tests.json"));
    const overlap = list("container-tests.json").filter((p) => unit.has(p));
    expect(overlap).toEqual([]);
  });

  it("lists only files that exist", () => {
    for (const p of [...list("unit-tests.json"), ...list("container-tests.json")]) {
      expect(() => readFileSync(new URL(`./${p}`, import.meta.url))).not.toThrow();
    }
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm exec vitest run packages/kernel/test/portfolio.test.ts`
Expected: FAIL — the JSON files do not exist yet.

- [ ] **Step 5: Add the three projects to `vitest.config.ts`**

After the `node` project, add projects built from the lists:

```ts
const kernelTest = (p: string) => `packages/kernel/test/${p}`;
const unitTests = JSON.parse(readFileSync(new URL("./packages/kernel/test/unit-tests.json", import.meta.url), "utf8")) as string[];
const containerTests = JSON.parse(readFileSync(new URL("./packages/kernel/test/container-tests.json", import.meta.url), "utf8")) as string[];
```

- `kernel-unit`: `include: unitTests.map(kernelTest)`, no `globalSetup`, `testTimeout: 5_000`, `hookTimeout: 10_000`.
- `kernel-integration`: `include: ["packages/kernel/test/**/*.test.ts"]`, `exclude: [...unitTests, ...containerTests].map(kernelTest)`, the same `globalSetup`, `testTimeout: 30_000`, `hookTimeout: 120_000`.
- `kernel-container`: `include: containerTests.map(kernelTest)`, the same `globalSetup`, `testTimeout: 240_000`, `hookTimeout: 300_000`.
- The `node` project keeps its globs but adds `"packages/kernel/test/**"` to `exclude`.

- [ ] **Step 6: Run the unit project and reclassify failures**

Run: `pnpm exec vitest run --project kernel-unit`
Expected: PASS. Every failure caused by a missing database/Redis (connection refused, `startTestPostgres` not called) means the file belongs in integration: move it from `unit-tests.json` to the integration remainder (delete it from the unit list) and rerun until green. Do not loosen the unit project by adding `globalSetup`.

- [ ] **Step 7: Verify the collected count is unchanged**

Record `pnpm exec vitest list packages/kernel --filesOnly | wc -l` **before** changing the config (expected 577). After the split it must be the same number plus one (the new `portfolio.test.ts`): every kernel test file still runs, in exactly one project.

- [ ] **Step 8: Run the full kernel suite**

Run: `pnpm exec vitest run packages/kernel`
Expected: PASS, 6,014 tests plus the new portfolio tests.

- [ ] **Step 9: Commit**

```bash
git add vitest.config.ts packages/kernel/test/unit-tests.json packages/kernel/test/container-tests.json packages/kernel/test/portfolio.test.ts
git commit -m "test: split kernel suite into unit, integration and container projects"
```

---

### Task 2: Coverage baseline tooling

**Files:**
- Modify: `package.json` (devDependency + script)
- Create: `tools/dev/src/coverage-baseline.ts`
- Create: `tools/dev/test/coverage-baseline.test.ts`

**Interfaces:**
- Produces: `renderCoverageBaseline(summary: CoverageSummary): string` (markdown), and a script `pnpm coverage:baseline` that reads `coverage/coverage-summary.json` and writes `docs/testing/coverage-baseline.md`.

- [ ] **Step 1: Write the failing test**

Create `tools/dev/test/coverage-baseline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderCoverageBaseline } from "../src/coverage-baseline.js";

it("groups kernel src files into module rows sorted by path", () => {
  const md = renderCoverageBaseline({
    total: { lines: { total: 3, covered: 2, pct: 66.6 } },
    "packages/kernel/src/runtime/a.ts": { lines: { total: 2, covered: 2, pct: 100 } },
    "packages/kernel/src/runtime/b.ts": { lines: { total: 1, covered: 0, pct: 0 } },
  });
  expect(md).toContain("| runtime | 3 | 2 | 66.7% |");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tools/dev/test/coverage-baseline.test.ts`
Expected: FAIL — `renderCoverageBaseline` is not exported.

- [ ] **Step 3: Implement the renderer**

In `tools/dev/src/coverage-baseline.ts` export `type CoverageSummary = Record<string, { lines: { total: number; covered: number; pct: number } }>` and `renderCoverageBaseline(summary): string`. Module key = the second path segment under `packages/kernel/src/` (`runtime`, `catalog`, …); sum totals and covered, pct = covered/total×100 rounded to one decimal (`—` when total is 0). Ignore the `total` key. Emit a header, a table `| module | lines | covered | pct |`, and a footer line `Generated by pnpm coverage:baseline`. The CLI entry writes `docs/testing/coverage-baseline.md` from `coverage/coverage-summary.json`.

- [ ] **Step 4: Add the dependency and scripts**

Add `"@vitest/coverage-v8": "^5.0.5"` to root `devDependencies` and scripts:

```json
"coverage": "vitest run --coverage --coverage.reporter=json-summary --coverage.include='packages/kernel/src/**' packages/kernel",
"coverage:baseline": "tsx tools/dev/src/coverage-baseline.ts"
```

Run `pnpm install` and commit the lockfile change.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run tools/dev/test/coverage-baseline.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tools/dev/src/coverage-baseline.ts tools/dev/test/coverage-baseline.test.ts
git commit -m "test: add kernel coverage baseline tooling"
```

Record the baseline itself in Task 13, immediately before T2 starts.

---

### Task 3: `check:test-portfolio`

**Files:**
- Create: `tools/checks/src/test-portfolio.ts`
- Create: `tools/checks/src/cli/test-portfolio.ts`
- Create: `tools/checks/test/test-portfolio.test.ts`
- Create: `tools/checks/fixtures/test-portfolio/{clean,bad}/…`
- Create: `tools/checks/test-portfolio-baseline.json`
- Modify: `tools/checks/src/cli/all.ts`, `package.json`, `tools/checks/README.md`

**Interfaces:**
- Consumes: `Finding` and the source scanner from `@capybara-hq/plugin-tools/source`; baseline JSON shape `{ "files": string[] }` of repo-relative test paths.
- Produces: `checkTestPortfolio(opts: { root: string; baseline?: string[]; changed?: Set<string> }): Finding[]` and `listCandidates(root: string, area: string): string[]`.

- [ ] **Step 1: Write the failing test**

Create `tools/checks/test/test-portfolio.test.ts` with two fixtures. `fixtures/test-portfolio/bad/` holds a test file with `sleep(100)`, `new Promise((r) => setTimeout(r, 50))`, an `it(…, { timeout: 30_000 }, …)`, a third-argument `beforeAll(…, 60_000)`, a file importing `helpers/runs` with two tests and two `startKernel(` calls. Assert the returned rules in order:

```ts
expect(checkTestPortfolio({ root })).toEqual([
  expect.objectContaining({ rule: "test-fixed-sleep" }),
  expect.objectContaining({ rule: "test-fixed-settimeout" }),
  expect.objectContaining({ rule: "test-timeout-override" }),
  expect.objectContaining({ rule: "test-timeout-override" }),
  expect.objectContaining({ rule: "test-small-app-file" }),
  expect.objectContaining({ rule: "test-double-boot" }),
]);
```

Add cases: a file in the baseline is skipped; `changed` restricts the scan to those paths; overlapping `unit-tests.json` / `container-tests.json` yields `test-portfolio-list-overlap`; a listed path that does not exist yields `test-portfolio-missing-file`; a `--base` that does not resolve (non-merge checkout) makes the CLI exit 0 with a "skipped" line, like `check:applied-migrations`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tools/checks/test/test-portfolio.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the check**

Rules, scanning only `packages/kernel/test/**/*.test.ts` (the `changed` set narrows it; the baseline is file-level and skips a whole file):

| Rule | Detect |
|---|---|
| `test-fixed-sleep` | a call to `sleep` with a numeric literal argument |
| `test-fixed-settimeout` | `new Promise(…)` whose body calls `setTimeout` with a numeric literal |
| `test-timeout-override` | a `timeout:` property in an options object, or a numeric third argument to `it`/`test`/`describe`/`before*`/`after*` |
| `test-small-app-file` | a file importing `helpers/runs`, `helpers/http-app`, or calling `buildKernel`/`startKernel`, with ≤5 `it`/`test` calls |
| `test-double-boot` | more than one `buildKernel(`/`startKernel(` call in one file |
| `test-portfolio-list-overlap` | a path in both lists (second occurrence reported) |
| `test-portfolio-missing-file` | a listed path with no file |

Use the existing source helpers for parsing where they fit; a regex over the parse result is acceptable for the wait rules, and the README must state that limitation.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tools/checks/test/test-portfolio.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the CLI and registration**

`tools/checks/src/cli/test-portfolio.ts`: with `--base <sha>` run `git diff --name-only <sha>...HEAD` and pass the changed test files; a `--base` that does not resolve prints "skipped: no --base given" and exits 0 (the same contract as `check:applied-migrations`), and no `--base` scans the whole tree (the `pnpm check` mode). `--list --area <path>` prints the candidates for that area (small app files, files with fixed waits, files with overrides) one per line, for the T1 batches. Register `{ name: "Test portfolio", run: () => checkTestPortfolio({ root }) }` in `tools/checks/src/cli/all.ts`; add `"check:test-portfolio"` to `package.json` in the existing tsx style; add a `tools/checks/README.md` entry stating full vs diff (diff on PRs by changed files, full in `pnpm check`) and the grandfather list.

- [ ] **Step 6: Generate the grandfather list and verify the check fails without it**

Run the CLI over the whole tree and write every violating path into `tools/checks/test-portfolio-baseline.json`; run it once more with an empty baseline and confirm it fails on the known violations, then with the real baseline and confirm it passes.

- [ ] **Step 7: Commit**

```bash
git add tools/checks/src/test-portfolio.ts tools/checks/src/cli/test-portfolio.ts \
  tools/checks/test/test-portfolio.test.ts tools/checks/fixtures/test-portfolio \
  tools/checks/test-portfolio-baseline.json tools/checks/src/cli/all.ts \
  package.json tools/checks/README.md
git commit -m "chore: add the test portfolio check"
```

---

### Task 4: Write the policy into AGENTS.md

**Files:**
- Modify: `AGENTS.md` (Common commands / a "Tests" bullet)

**Interfaces:** none.

- [ ] **Step 1: Add the bullet**

Add under the rules-by-area list: **Tests:** unit tests need no database or app; integration tests use one app per file; dual-replica tests live in the `container` project; no fixed sleeps, no per-test timeouts; a new unit or container test joins its checked-in list in the same change (integration is the default). Link `docs/superpowers/specs/2026-11-14-test-portfolio-design.md`.

- [ ] **Step 2: Run the docs checks**

Run: `pnpm check:agent-docs && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md && git commit -m "docs: state the test level policy"
```

---

### Tasks 5–12: T1 area batches

Run one task per area, in this order: `catalog`, `tools`, `migrations`, `channels`, `runtime`, `extensions`, `infra`, then the remaining areas (`admin`, `agents`, `background`, `channels` done, `conversations`, `db`, `devices`, `evals`, `identity`, `local-devices`, `orgs`, `platform`, `sandbox`, `schedules`, `skills`, `subagents`, `themes`, `ui`, root files) as one batch.

Each task is identical apart from the area path; the steps below are the template (`<area>` = `packages/kernel/test/<dir>`).

- [ ] **Step 1: List the area's candidates**

Run: `pnpm check:test-portfolio --list --area <area>`
Expected: the small app-booting files, the files with fixed waits and the files with timeout overrides, one per line.

- [ ] **Step 2: Record the area's counts before touching it**

Run: `pnpm exec vitest list <area> --filesOnly | wc -l` and `pnpm exec vitest list <area> | wc -l` (files, tests). Save both numbers. The test count must be identical after the batch; the file count drops by the number of merges, which is expected.

- [ ] **Step 3: Merge the small app-booting files**

Group files in the same directory (or one subdirectory) into one file: keep every `describe` block, its name and every test body verbatim; keep `beforeEach`/`afterEach` inside the describe they served, and hoist only imports. A merged file holds 6–25 tests and starts the app once. Update `unit-tests.json`/`container-tests.json` if the merged file's category changes.

- [ ] **Step 4: Replace fixed waits**

Replace `sleep(n)` and `new Promise(… setTimeout(… n …))` with `waitFor`/`waitForEvent` from `helpers/runs` or the injected clock from `helpers/lock-clock`. For "nothing happened" assertions, assert on recorded state or wait for a positive marker. Every replacement must keep the test just as strong; if a wait cannot be replaced without weakening it, leave it and note it in the PR.

- [ ] **Step 5: Remove timeout overrides**

Delete every `timeout:` property and third-argument timeout in the area; the projects now carry the limits. A test that needs longer belongs in the `container` list instead.

- [ ] **Step 6: Run the area's tests**

Run: `pnpm exec vitest run <area>`
Expected: PASS with exactly the test count recorded in Step 2. The file count is lower by the number of merges; confirm the difference equals that number.

- [ ] **Step 7: Shrink the grandfather list**

Remove every `<area>` path that is now clean from `tools/checks/test-portfolio-baseline.json`; run `pnpm check:test-portfolio --base "$(git rev-parse HEAD^1)"` and confirm the area reports nothing.

- [ ] **Step 8: Commit**

```bash
git add <area> packages/kernel/test/unit-tests.json packages/kernel/test/container-tests.json \
  tools/checks/test-portfolio-baseline.json
git commit -m "test: converge <area> tests (merge, waits, timeouts)"
```

---

### Task 13: Record the coverage baseline

**Files:**
- Create: `docs/testing/coverage-baseline.md`
- Modify: `docs/testing/coverage-baseline.md` is generated — no hand edits.

- [ ] **Step 1: Measure**

Run: `pnpm coverage` then `pnpm coverage:baseline`.
Expected: `docs/testing/coverage-baseline.md` generated from `coverage/coverage-summary.json`; every kernel module has a row.

- [ ] **Step 2: Sanity-check the numbers**

Compare the `skills`, `catalog` and `runtime` rows against the source sizes in the design; a module at 0 % usually means the run only collected unit tests (run the full `packages/kernel` filter, not one project).

- [ ] **Step 3: Commit**

```bash
git add docs/testing/coverage-baseline.md
git commit -m "docs: record the kernel coverage baseline before pruning"
```

---

### Tasks 14–21: T2 pruning area batches

Same areas and order as T1. Each task is a proposal, an approval, then deletions; the plan template (`<area>` = `packages/kernel/test/<dir>`).

- [ ] **Step 1: Build the area's candidate list**

Apply the four approved criteria: mock-call assertions (`toHaveBeenCalled`), log/internal-string assertions, behavior already covered by an integration test with no extra branch coverage, and framework/third-party behavior. For each candidate write: file, test name, criterion, and where the behavior is still covered (or `none`). Flag anything that looks like a contract (error code, permission outcome, user-facing copy) separately.

- [ ] **Step 2: Post the list and wait for approval**

Commit the list as the PR description draft (a comment on the branch's PR, or a message to the maintainer). Do not delete anything until the list is approved.

- [ ] **Step 3: Delete the approved tests**

Delete only the approved tests (whole `it` blocks and fixtures used only by them). Keep helpers used elsewhere.

- [ ] **Step 4: Run the area's tests**

Run: `pnpm exec vitest run <area>`
Expected: PASS; record the remaining test count.

- [ ] **Step 5: Measure the coverage delta**

Run: `pnpm coverage` and render the summary to a scratch copy (do **not** overwrite
`docs/testing/coverage-baseline.md` during T2 — the committed baseline is the fixed reference all
batches compare against until Task 22). Compare the affected modules with the committed baseline.
If a module drops, either restore the test that covered it or state the deliberate decision in the
PR description.

- [ ] **Step 6: Commit**

```bash
git add <area>
git commit -m "test: prune <area> implementation-detail tests"
```

The coverage baseline doc is not part of a T2 batch commit; Task 22 records the post-pruning
baseline once, deliberately.

---

### Task 22: Close-out and measurement

**Files:**
- Modify: `docs/superpowers/specs/2026-11-14-test-portfolio-design.md` (status → implemented, measurements)

- [ ] **Step 1: Measure CI**

From a kernel-touching PR: `gh run view <id> --json jobs --jq '.jobs[] | [.name, .startedAt, .completedAt] | @tsv'`. Record the test-shard durations against the 348–535 s baseline.

- [ ] **Step 2: Fill the before/after table**

Test count, files, app-booting files, fixed waits, timeout overrides (three forms), per-module coverage, per-job durations.

- [ ] **Step 3: Record the post-pruning coverage baseline and verify the guards**

Run: `pnpm coverage && pnpm coverage:baseline` and commit the new
`docs/testing/coverage-baseline.md` once, with the deliberate drops named in the commit message.
Then run `pnpm check` and `pnpm exec vitest run packages/kernel`.
Expected: PASS; `test-portfolio-baseline.json` is `{"files": []}`.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/superpowers/specs/2026-11-14-test-portfolio-design.md
git commit -m "docs: record the test portfolio results"
```

Open one PR for the branch; the PR body carries the before/after table and the design link.
