# Contributor Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the shared contributor workflow: a new `capybara-hq/.github` repository (org defaults, issue gate, settings script, shared skills, org profile) and its first consumer, `capybara-hq/core` (`pnpm doctor`, `pnpm verify`, upstream-aware worktrees, synced skills, gate caller, CODEOWNERS, docs), then roll out the rulesets.

**Architecture:** Logic that GitHub runs (gate, settings, skill sync) is plain Node 24 TypeScript in `capybara-hq/.github`, run with `node` (type stripping), tested with `node --test`, no runtime dependencies; reusable workflows check out that repository at the called tag and run the scripts, never the PR's code. `core` gets a new private package `tools/dev` for `doctor` / `verify`, reuses `tools/ci`'s plan, and gains one custom check for synced skills.

**Tech Stack:** Node 24, pnpm 10, TypeScript (erasable syntax), `node:test` in `.github`, vitest in `core`, GitHub REST API through `fetch`, GitHub Actions (`workflow_call`, `pull_request_target`, `issues`, `issue_comment`), repository rulesets.

**Spec:** `docs/superpowers/specs/2026-10-23-contributor-workflow-design.md`

## Global Constraints

- Node 24, pnpm 10. Scripts in `capybara-hq/.github` use only Node built-ins plus `typescript` / `@types/node` as dev dependencies.
- New code, comments, identifiers, user-facing messages, docs and skills are English. Existing Chinese files are not translated (spec non-goal); new lines added to them are English.
- Conventional Commits, body lines ≤ 100 characters, ending with the `Co-Authored-By` line from the session's attribution reminder.
- A workflow triggered by `pull_request_target` never checks out or executes the PR's code; it reads the PR and issues through the API only.
- Labels, exact names: `needs-triage`, `needs-info`, `accepted`, `good first issue`, `help wanted`. Labels that count as accepted: `accepted`, `good first issue`, `help wanted`.
- Required statuses on `main`: exactly `ci-ok` and `issue-linked`, both with `integration_id: 15368` (GitHub Actions).
- Team: `@capybara-hq/maintainers` (slug `maintainers`; resolve its id at run time, today `20278965`).
- Exempt bots: `github-actions[bot]`, `dependabot[bot]`, `renovate[bot]`.
- Closing keywords: `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved` (case-insensitive).
- Contacts: `284885069@qq.com` for code of conduct and security; first security reply within 2 days; before 1.0 only the latest release gets security fixes. (Switch to `conduct@` / `security@capybarahq.com` later, once the maintainer has set up Cloudflare forwarding; not part of this plan.)
- Versions of `capybara-hq/.github`: immutable tags `v1.x.y` plus a moving `v1`. Consumers call workflows `@v1`.
- Synced skill frontmatter: `metadata.source: capybara-hq/.github`, `metadata.version: v1.x.y`, `metadata.sha256: <hex>`.
- `doctor` / `verify` JSON: `{ "ok": boolean, "checks": [{ "id": string, "title": string, "status": "pass" | "fail" | "warn" | "skip", "detail": string, "fix"?: string }] }`; exit 0 iff no `fail`.
- Stop and ask the maintainer before: creating `capybara-hq/.github`, the first push to its `main`, applying rulesets to any repository, deleting a ruleset, publishing contacts (first PR containing `CODE_OF_CONDUCT.md` / `SECURITY.md`). Every other outward action (push, opening a PR) follows the usual "say what you're about to do" rule.

## Review Focus

1. **Rulesets applied before the gate posts statuses**: requiring `issue-linked` on a repository whose PRs never get that status blocks every merge, maintainers included. `settings apply` must refuse (Task A6, `preflight`).
2. **Unusual issue references in PR bodies**: `Closes capybara-hq/core#12`, a full issue URL, a reference to another repository, `#12` without a keyword, several references. Only same-repo references with a keyword count; any one qualifying issue passes (Task A4).
3. **Permission lookups for strangers**: the collaborator-permission API for someone with no access returns `none` / `read` or 404; that is "not exempt", not "lookup failed". Only 401 / 403 / 5xx / network errors fail with the "could not read permission" message (Task A5).
4. **Many open PRs when an issue changes**: re-evaluation must page through all open PRs (Task A5).
5. **`/claim` look-alikes**: only a comment whose first line, trimmed, is exactly `/claim` claims; quoting `/claim` in prose does nothing; claiming an issue already assigned to the commenter replies "already yours" (Task A4).

---

## Part A: `capybara-hq/.github`

Local checkout: `/Users/grant/Capybara/dot-github` (`gh repo clone capybara-hq/.github /Users/grant/Capybara/dot-github`). Work on branches and PRs after the first commit.

### Task A1: Create the repository and its scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `README.md`, `.github/workflows/ci.yml`, `src/smoke.test.ts`

**Interfaces:**
- Produces: `pnpm test` = `node --test "src/**/*.test.ts"`; `pnpm typecheck` = `tsc --noEmit`. tsconfig: `module`/`moduleResolution` `nodenext`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `noEmit`, `strict`, `types: ["node"]`. All imports between source files use `.ts` extensions.

- [ ] **Step 1: Ask the maintainer**, then `gh repo create capybara-hq/.github --public --description "Community health files, shared workflows and agent skills for capybara-hq repositories"` and clone it to `/Users/grant/Capybara/dot-github`.
- [ ] **Step 2: Write the scaffold.** `package.json`: `"private": true`, `"type": "module"`, `"version": "1.0.0"`, `engines.node ">=24"`, `packageManager` same as core (`pnpm@10.34.3`), scripts `test`, `typecheck`. `ci.yml`: on `pull_request` and `push` to `main`; checkout, pnpm/action-setup, setup-node 24, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`. `README.md`: three lines on what the repository holds and a link to `profile/README.md`. `src/smoke.test.ts`: one `node:test` test asserting `1 + 1 === 2`, deleted in Task A4.
- [ ] **Step 3: Run** `pnpm install && pnpm typecheck && pnpm test`. Expected: 1 test passes.
- [ ] **Step 4: Ask the maintainer**, then commit `chore: scaffold the org .github repository` and push to `main` (the only direct push in this plan; the repository is empty).

### Task A2: Org default community files

**Files:**
- Create: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/bug.yml`, `.github/ISSUE_TEMPLATE/feature.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/pull_request_template.md`
- Test: `src/templates.test.ts`

**Interfaces:**
- Produces: `FORM_SECTIONS: Record<"bug" | "feature", { label: string; required: boolean }[]>` exported from `src/gate/forms.ts`, the single list both the forms and the format check (Task A4) agree on; the test keeps the YAML in sync with it.

Form fields (labels exact; `required` as listed):
- bug: `What happened` (req), `Steps to reproduce` (req), `Expected behavior` (req), `Version or commit` (req), `Environment` (optional).
- feature: `Problem` (req), `Proposed solution` (req), `Alternatives considered` (optional).
Both forms: `labels: [needs-triage]` (bug also `bug`, feature also `enhancement`). `config.yml`: `blank_issues_enabled: false`; one contact link "Report a security vulnerability" → `https://github.com/capybara-hq/core/security/advisories/new`.

- [ ] **Step 1: Write the failing test** `src/templates.test.ts`: `forms list exactly FORM_SECTIONS` parses each form's `body[]` (a minimal YAML reader for this shape is fine, or match `label:` lines) and asserts labels and `validations.required` equal `FORM_SECTIONS`; `forms apply needs-triage`; `config disables blank issues`.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL, files missing.
- [ ] **Step 3: Write the files.** `CODE_OF_CONDUCT.md`: Contributor Covenant 2.1 verbatim, enforcement contact `284885069@qq.com`. `SECURITY.md`: report through GitHub private vulnerability reporting (preferred) or `284885069@qq.com`; first reply within 2 days; no fixed time to fix, depends on severity; supported versions table: before 1.0 only the latest release, fixes ship in the next release, no backports. `CONTRIBUTING.md` (humans): the two kinds of contributors and the remotes (spec §3), issue → `accepted` → `/claim` → PR with `Closes #N` (spec §4), no exemptions for small PRs, who merges (spec §5), `pnpm doctor` / `pnpm verify`, agents optional and where the skills are, a placeholder "Supported agents" table filled in Task C2, link to each repository's `AGENTS.md`. PR template: What and why; `Closes #`; checklist `pnpm verify` passes, changeset if a published package changed, design doc linked for larger changes.
- [ ] **Step 4: Run** `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `docs: add org default community files` on branch `docs/community-files`, open the PR (it publishes the contacts: confirm with the maintainer first). After merge, check on github.com that `capybara-hq/core` shows the org `CODE_OF_CONDUCT` / `SECURITY` and the "New issue" chooser shows both forms; if templates are not picked up from `.github/ISSUE_TEMPLATE/`, move them to the repository root `ISSUE_TEMPLATE/` and re-check.

### Task A3: Organization profile

**Files:**
- Create: `profile/README.md`, `profile/capybara.svg`, `scripts/logo-svg.ts`
- Test: `src/logo.test.ts`

**Interfaces:**
- Produces: `logoSvg(opts: { cell: number; fill: string }): string` in `scripts/logo-svg.ts`, using the bitmap copied verbatim from `core/packages/design/src/display/logo.tsx` (`CAPYBARA_BITMAP`, 14×10, `X` filled, `O` eye cut out).

- [ ] **Step 1: Write the failing test** `logoSvg draws one square per X`: for `cell: 10`, the SVG has `viewBox="0 0 140 100"`, `shape-rendering="crispEdges"`, and the path has as many `h10v10h-10z` segments as there are `X` in the bitmap (count them from the bitmap in the test, don't hard-code).
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `logoSvg`; write `profile/capybara.svg` with `cell: 10`, `fill: "#FF6A13"`, transparent background.
- [ ] **Step 4: Write `profile/README.md`**: logo (`<img src="capybara.svg" width="112">`), the tagline "The calm agent that plugs into every system in your company and gets the work done." and the Chinese line "情绪稳定地接入企业内的所有系统，帮你把工作处理好。", two or three sentences on what Capybara is (kernel + plugins, from core's README), repositories table (`core` now; plugins repository "coming after M7"), quick start link to core's README, "Contributing" (link to org `CONTRIBUTING.md`, `good first issue` search URL `https://github.com/search?q=org%3Acapybara-hq+label%3A%22good+first+issue%22+is%3Aopen&type=issues`), license Apache-2.0.
- [ ] **Step 5: Run** `pnpm test`. Expected: PASS. Commit `docs: add the organization profile`, PR. After merge, check github.com/capybara-hq shows it.

### Task A4: Gate decisions (pure)

**Files:**
- Create: `src/gate/forms.ts` (from A2), `src/gate/refs.ts`, `src/gate/issue-linked.ts`, `src/gate/issue-format.ts`, `src/gate/claim.ts`
- Test: `src/gate/refs.test.ts`, `src/gate/issue-linked.test.ts`, `src/gate/issue-format.test.ts`, `src/gate/claim.test.ts`
- Delete: `src/smoke.test.ts`

**Interfaces:**
- Produces:
  - `closingRefs(body: string, repo: string /* "owner/name" */): number[]`: issue numbers referenced with a closing keyword as `#N`, `owner/name#N` (same repo) or `https://github.com/owner/name/issues/N` (same repo); deduplicated, in order.
  - `type IssueState = { number: number; state: "open" | "closed"; labels: string[]; assignees: string[] }`
  - `type Author = { login: string; type: "User" | "Bot"; permission: "admin" | "maintain" | "write" | "triage" | "read" | "none" | "unknown" }` (`unknown` = lookup failed)
  - `decideIssueLinked(input: { author: Author; body: string; repo: string; issues: Map<number, IssueState | null> }): { state: "success" | "failure"; description: string; comment: string | null }`. `issues` holds every number from `closingRefs` (`null` = not found). `description` ≤ 140 chars (status API limit). `comment` is null on success.
  - `checkIssueFormat(body: string): { ok: boolean; missing: string[] }`: ok when all required sections of at least one form are present and non-empty; `missing` lists the required labels of the closest form (fewest missing).
  - `parseClaim(body: string): boolean`; `decideClaim(input: { commenter: string; issue: IssueState }): { action: "assign" | "reply"; message: string }`.

- [ ] **Step 1: Write the failing tests.** Exact cases:
  - refs: `"Closes #12"` → `[12]`; `"fixes capybara-hq/core#7 and resolves https://github.com/capybara-hq/core/issues/8"` → `[7, 8]`; `"Closes other/repo#3"` → `[]`; `"See #12"` → `[]`; `"CLOSES #5, closes #5"` → `[5]`.
  - issue-linked: permission `write` / `maintain` / `admin` → success "Exempt: has write access"; bot in allowlist → success; bot not in list → treated like a user; permission `unknown` → failure, description starts "Could not read the author's permission"; no refs → failure, comment mentions `Closes #<number>` and `/claim`; ref to `null` issue → failure "#N not found"; closed issue → failure; open, no accepted label → failure "not accepted yet"; open + `good first issue` + unassigned → success; open + `accepted` + assigned to someone else → failure naming the assignee; open + `accepted` + assigned to author → success; two refs, one qualifying → success.
  - format: body with `### What happened\n\nx\n\n### Steps to reproduce\n\ny\n\n### Expected behavior\n\nz\n\n### Version or commit\n\nv1` → ok; same with `_No response_` under a required heading → missing that label; free text without headings → missing = feature's two required labels (fewest missing).
  - claim: `"/claim"`, `"  /claim  \nthanks"` → true; `"I will /claim this"`, `"> /claim"` → false. decideClaim: unassigned → assign; assigned to commenter → reply contains "already assigned to you"; assigned to other → reply names them; issue without an accepted label → reply "not accepted yet".
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the five modules.
- [ ] **Step 4: Run** `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add issue gate decisions`.

### Task A5: GitHub client, gate entrypoint, reusable workflow

**Files:**
- Create: `src/github.ts`, `src/gate/run.ts`, `.github/workflows/gate.yml`
- Test: `src/github.test.ts`, `src/gate/run.test.ts`

**Interfaces:**
- Consumes: Task A4 functions.
- Produces:
  - `createClient(opts: { token: string; fetch?: typeof fetch; apiUrl?: string }): GitHub` with methods `getPR(repo, n)`, `listOpenPRs(repo): AsyncIterable<PR>` (follows `Link: rel="next"`), `getIssue(repo, n): Promise<IssueState | null>`, `getPermission(repo, login): Promise<Author["permission"]>` (404 → `none`; 401/403/5xx/network → `unknown`), `setStatus(repo, sha, { state, description, context: "issue-linked" })`, `upsertComment(repo, n, marker: string, body: string | null)` (finds its own earlier comment by the hidden marker `<!-- capybara-gate:<marker> -->`; edits it, deletes it when `body` is null, creates it otherwise), `addLabels`, `removeLabel`, `assign(repo, n, login)`.
  - `runGate(event: { name: string; payload: unknown; repo: string }, gh: GitHub): Promise<void>`, dispatching: `pull_request_target` → evaluate that PR; `issues` `opened`/`edited` → format check (skip when the author has write access); `issues` `labeled`/`unlabeled`/`assigned`/`unassigned`/`closed`/`reopened` → evaluate every open PR whose `closingRefs` include the issue; `issue_comment` `created` on an issue (not a PR) with `parseClaim` → claim.
  - CLI: `node src/gate/run.ts` reads `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GITHUB_TOKEN`.
  - `gate.yml`: `on: workflow_call` with input `tools-ref` (default `v1`); one job, `permissions: { contents: read, issues: write, pull-requests: write, statuses: write }`; steps: `actions/checkout` with `repository: capybara-hq/.github`, `ref: ${{ inputs.tools-ref }}`, `path: .capybara-gate`; setup-node 24; `node .capybara-gate/src/gate/run.ts`. No install step, no checkout of the caller's code.

- [ ] **Step 1: Write the failing tests** with a fake `fetch` (a table of `method url → status, body, headers`): `listOpenPRs follows Link next across 3 pages`; `getPermission maps 404 to none and 502 to unknown`; `upsertComment edits the marked comment instead of adding one`; run: `pull_request_target sets failure status and comments`, `labeling an issue accepted re-evaluates the PR that closes it and deletes the gate comment`, `issues opened without sections adds needs-info and comments once; edited with sections removes needs-info`, `/claim on an accepted unassigned issue assigns the commenter`, `issue_comment on a PR is ignored`.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `github.ts`, `run.ts`, `gate.yml`.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add the issue gate workflow`, PR.

### Task A6: Settings script

**Files:**
- Create: `src/settings/desired.ts`, `src/settings/diff.ts`, `src/settings/cli.ts`
- Test: `src/settings/diff.test.ts`

**Interfaces:**
- Consumes: `createClient` (Task A5; add `getRulesets`, `createRuleset`, `updateRuleset`, `deleteRuleset`, `getLabels`, `upsertLabel`, `getTeamId(org, slug)`, `getFile(repo, path)`, `getPrivateReporting(repo)`, `enablePrivateReporting(repo)`, `listRecentStatuses(repo, context)`).
- Produces:
  - `desired(teamId: number): Desired`: the five labels (with colors and one-line descriptions), rulesets `main-quality`, `main-review`, `main-merge` exactly as spec §5 (`main-quality`: deletion, non_fast_forward, pull_request with 0 approvals and merge methods `merge`/`squash`/`rebase`, required_status_checks `ci-ok` + `issue-linked` with `strict_required_status_checks_policy: true`, no bypass; `main-review`: pull_request with 1 approval, `require_code_owner_review`, `require_last_push_approval`, `dismiss_stale_reviews_on_push`, bypass `{ actor_type: "Team", actor_id: teamId, bypass_mode: "pull_request" }`; `main-merge`: `update` rule, same bypass), CODEOWNERS must contain `@capybara-hq/maintainers`, private vulnerability reporting on.
  - `diffSettings(want: Desired, have: Actual): Drift[]` where `Drift = { kind: "label" | "ruleset" | "unmanaged-ruleset" | "codeowners" | "private-reporting"; name: string; detail: string }`. Rulesets compared on the fields `desired` sets only.
  - `preflight(have: Actual): string[]`: reasons not to apply; non-empty when no workflow file in `.github/workflows/` uses `capybara-hq/.github/.github/workflows/gate.yml`, or no `issue-linked` status was set on the repository in the last 30 days.
  - CLI: `node src/settings/cli.ts check <owner/repo>` (prints drift, exit 1 if any) and `apply <owner/repo> [--prune]` (runs `preflight`, refuses on reasons; applies labels, rulesets, private reporting; deletes `unmanaged-ruleset` drift only with `--prune`; never writes CODEOWNERS, only reports it). Token from `GH_TOKEN` or `gh auth token`.

- [ ] **Step 1: Write the failing tests**: `no drift when actual equals desired`; `extra fields GitHub adds are ignored`; `a changed approval count is ruleset drift`; `protect-main is unmanaged-ruleset drift`; `missing team in CODEOWNERS is drift`; `preflight refuses without the gate workflow`; `preflight refuses without a recent issue-linked status`.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS. Then `node src/settings/cli.ts check capybara-hq/core` (read only). Expected: drift listing the three missing rulesets, `protect-main` unmanaged, missing labels, missing CODEOWNERS.
- [ ] **Step 5: Commit** `feat: add the repository settings script`, PR.

### Task A7: Shared skills

**Files:**
- Create: `skills/onboarding/SKILL.md`, `skills/contributing/SKILL.md`, `skills/reviewing-prs/SKILL.md`
- Test: `src/skills.test.ts`

**Interfaces:**
- Consumes: the `doctor` / `verify` contract (Global Constraints), gate rules (Task A4).
- Produces: three skills whose frontmatter has `name` equal to the directory and a `description` ≤ 1024 chars that lists the plain-language triggers ("set up", "getting started"; "start on issue #N", "open a PR", "address review"; "review #N").

Content per spec §7, English. Must state, in each: run commands, don't re-implement them; outward actions only after the user agrees; never print secrets. `contributing`: sub-actions *start*, *verify*, *open the PR* (including the local pre-check of `issue-linked` rules via `gh issue view`, the PR body format, and the optional self-review), *address review* (read threads with `gh api graphql` for `reviewThreads`, reply per thread, re-request review); the workflow description for agents (two kinds of contributors, remotes, issue gate, no exemptions for small PRs, who merges). `reviewing-prs`: gather with `gh pr view --json`, `gh pr diff`, `gh pr checks`, `gh issue view`; never `gh pr checkout`, install or run the PR's code unless the maintainer asks, and then never with live API env loaded; check against `AGENTS.md` and the skills of touched areas; verdict + findings with file:line; draft review with inline comments; post only after confirmation; never merge.

- [ ] **Step 1: Write the failing test** `every skill has matching name and a description under 1024 chars` and `no skill mentions a repository-specific command other than pnpm doctor, pnpm verify, pnpm wt:new` (scan for `pnpm [a-z:-]+`).
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Write the skills.**
- [ ] **Step 4: Run** `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add onboarding, contributing and reviewing-prs skills`.

### Task A8: Skill sync command

**Files:**
- Create: `src/sync/hash.ts`, `src/sync/cli.ts`, `src/sync/fixtures/skill/SKILL.md`, `src/sync/fixtures/skill/extra.md`
- Test: `src/sync/hash.test.ts`

**Interfaces:**
- Produces:
  - `skillHash(files: { path: string; content: string }[]): string`: sort by `path` (relative to the skill directory, `/` separators); in `SKILL.md` remove the line matching `/^  sha256: [0-9a-f]*$/m`; sha256 hex of the concatenation of `${path}\0${content}\0`.
  - `stampFrontmatter(skillMd: string, meta: { version: string; sha256: string }): string`: sets `metadata.source`, `metadata.version`, `metadata.sha256` (two-space indent under `metadata:`), adds the comment line `# Synced from capybara-hq/.github. Edit the source there, then run sync.` above `metadata:`; keeps every other line.
  - CLI: `node src/sync/cli.ts --to <repo path> --version <tag>`: reads `skills/*` at `<tag>` with `git ls-tree -r --name-only <tag> skills/` and `git show <tag>:<path>` (so local edits don't leak), writes `<repo>/.agents/skills/<name>/`, removes files there that no longer exist upstream, stamps, prints what changed. Refuses if the tag doesn't exist. Does not commit.
- **Test vector:** the fixture skill's hash, computed once in Step 3 and pasted into both this test and core's Task B4 test as `FIXTURE_SHA256`.

- [ ] **Step 1: Write the failing tests**: `hash ignores the sha256 line`; `hash changes when any file changes`; `hash is independent of file order`; `stamp then hash round-trips` (stamp with a hash of the unstamped files, the stamped files hash to the same value); `fixture hash equals FIXTURE_SHA256`.
- [ ] **Step 2: Run** `pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement**; fill in `FIXTURE_SHA256`.
- [ ] **Step 4: Run** `pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add the skill sync command`.

### Task A9: Release tags and v1.0.0

**Files:**
- Create: `.github/workflows/release.yml`, `src/release.ts`
- Test: `src/release.test.ts`

**Interfaces:**
- Produces: `releaseTags(version: string, existing: string[]): string[]`: returns `[]` when `v${version}` exists, else `["v" + version, "v" + major]`. `release.yml`: on push to `main`, `permissions: contents: write`, reads `package.json` version, creates `v1.x.y` (fails if it exists on another commit) and force-moves `v<major>`.

- [ ] **Step 1: Write the failing test**: `new version gets its tag and the major tag`; `existing version gets nothing`; `rejects a non-semver version`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `ci: tag releases from package.json`; this PR also carries A4–A8 if they are still open. On merge the workflow tags `v1.0.0` and `v1`. Verify with `git ls-remote --tags origin`.

## Part B: `capybara-hq/core`

Worktree: `pnpm wt:new feat/contributor-workflow`. One PR for Part B. `tools/*` packages are private: no changeset.

Runs alongside `feat/m7-release` in another session. Overlap: `pnpm-lock.yaml` only (whoever merges second re-runs `pnpm install`). Don't run the dev stack (kernel, `pnpm dev:web`, `docker/compose.dev.yaml`) while the other session does; tests with their own containers are fine.

### Task B1: `tools/dev` with upstream detection and `pnpm doctor`

**Files:**
- Create: `tools/dev/package.json`, `tools/dev/tsconfig.json`, `tools/dev/src/report.ts`, `tools/dev/src/remotes.ts`, `tools/dev/src/doctor.ts`, `tools/dev/src/doctor-cli.ts`
- Modify: `tsconfig.json` (add reference `tools/dev`), `package.json` (script `"doctor": "node tools/dev/src/doctor-cli.ts"`)
- Test: `tools/dev/test/remotes.test.ts`, `tools/dev/test/doctor.test.ts`

**Interfaces:**
- Produces:
  - `type Check = { id: string; title: string; status: "pass" | "fail" | "warn" | "skip"; detail: string; fix?: string }`; `printReport(checks: Check[], json: boolean): number` (exit code) in `report.ts`.
  - `findUpstream(remotes: { name: string; url: string }[], repo: string /* "core" */): { remote: string; fork: boolean } | null` in `remotes.ts`: matches `https://github.com/capybara-hq/<repo>(.git)?` and `git@github.com:capybara-hq/<repo>(.git)?`, case-insensitive; `fork` is true when the match isn't `origin`. `readRemotes(cwd: string): { name: string; url: string }[]`.
  - `runDoctor(env: DoctorEnv): Promise<Check[]>` where `DoctorEnv = { root: string; exec(cmd: string, args: string[]): { status: number; stdout: string }; fileExists(p: string): boolean; readFile(p: string): string | null; isSymlinkTo(p: string, target: string): boolean; tcpOpen(port: number): Promise<boolean>; home: string; nodeVersion: string }`. Check ids, in order: `node` (major 24, fail), `pnpm` (major 10, fail), `deps` (`node_modules/.pnpm/lock.yaml` equals `pnpm-lock.yaml`, fail; fix `pnpm install`), `docker` (`docker info` exits 0, fail), `skills-link` (`.claude/skills` is a symlink to `../.agents/skills`, fail; fix mentions `git config core.symlinks true` and re-checkout), `remotes` (`findUpstream` non-null, fail; fix `git remote add upstream https://github.com/capybara-hq/core.git`), `git-identity` (fail), `gh` (installed and `gh auth status` exits 0, warn), `dev-services` (ports 5432 and 6379, warn), `live-api-env` (`~/.capybara-test.env` exists → pass with "present", else skip; never read it).
  - `doctor-cli.ts`: flags `--json`, `--fix` (only runs `pnpm install` for `deps`). Imports only Node built-ins and relative `.ts` files: it must run before `pnpm install`.

- [ ] **Step 1: Write the failing tests**: remotes `origin pointing to capybara-hq/core is not a fork`, `upstream pointing to capybara-hq/core via SSH is a fork`, `no match returns null`; doctor with a fake env: `all green`, `node 22 fails node`, `lockfile differs fails deps with fix`, `.claude/skills as a text file fails skills-link`, `gh missing warns, ok stays true`, `live-api-env skipped when absent and never read` (fake `readFile` throws if called with that path).
- [ ] **Step 2: Run** `pnpm exec vitest run tools/dev`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm exec vitest run tools/dev && node tools/dev/src/doctor-cli.ts`. Expected: tests pass; doctor prints a table, all required checks pass on this machine.
- [ ] **Step 5: Commit** `feat(dev): add pnpm doctor and upstream detection`.

### Task B2: `pnpm verify`

**Files:**
- Create: `tools/dev/src/verify.ts`, `tools/dev/src/verify-cli.ts`
- Modify: `tools/ci/package.json` (`"exports": { "./affected": "./src/affected.ts" }`), `tools/dev/package.json` (dependency `"@capybara-hq/ci": "workspace:*"`), `package.json` (script `"verify": "tsx tools/dev/src/verify-cli.ts"`)
- Test: `tools/dev/test/verify.test.ts`

**Interfaces:**
- Consumes: `findUpstream`, `Check`, `printReport` (B1); `planFromFiles`, `loadWorkspace`, `Plan` from `@capybara-hq/ci/affected`.
- Produces:
  - `changedFiles(cwd: string, base: string): string[]`: committed diff `base...HEAD` plus staged, unstaged and untracked files (designer's call in the spec: verify the working tree as it is).
  - `verifySteps(plan: Plan, base: string): { id: string; title: string; cmd: string[] | null; note?: string }[]`: `lint` (`pnpm lint`), `typecheck`, `check`, `commitlint` (`pnpm exec commitlint --from <base> --to HEAD`), `test` (`pnpm test` when `plan.all`; `pnpm exec vitest run <testDirs...>` when `plan.test`; `cmd: null` with note "no affected tests" otherwise), then `web`, `visual`, `e2e` with `cmd: null` and note "CI runs this" when the plan includes them.
  - `changesetWarning(files: string[], ws: Workspace, root: string): Check | null`: warn when a non-private workspace package changed and no `.changeset/*.md` (other than README) is among the files.
  - CLI: finds upstream (fail with B1's fix text if none), `git fetch <remote> main`, base = `git merge-base HEAD <remote>/main`, prints base, files count and the plan, runs steps in order (continues after a failure), prints the report; `--json`.

- [ ] **Step 1: Write the failing tests**: `verifySteps for a docs-only plan has no test command`; `plan.all runs pnpm test`; `testDirs become vitest filters`; `web/visual/e2e are reported, not run`; `changeset warning for packages/kernel without a changeset`, `none for tools/dev` (private); `changedFiles includes an untracked file` (temp git repo, reuse the pattern of `tools/worktree/test/helpers.ts`).
- [ ] **Step 2: Run** `pnpm exec vitest run tools/dev`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests (PASS), then `pnpm verify` on this branch. Expected: prints the plan, all steps pass.
- [ ] **Step 5: Commit** `feat(dev): add pnpm verify`.

### Task B3: Worktrees start from upstream

**Files:**
- Modify: `tools/worktree/src/worktree.ts` (`parseNewArgs`, `cmdNew`), `tools/worktree/package.json` (dependency `"@capybara-hq/dev": "workspace:*"`), `tools/dev/package.json` (`"exports": { "./remotes": "./src/remotes.ts" }`)
- Test: `tools/worktree/test/worktree.test.ts`

**Interfaces:**
- Consumes: `findUpstream`, `readRemotes` (B1).
- Produces: `parseNewArgs(argv, remotes, defaultFrom: string)`; `cmdNew` computes `defaultFrom = \`${upstream?.remote ?? "origin"}/main\`` and fetches that remote (plus `origin` when different). Existing-remote-branch detection stays on `origin`. The success JSON's `mode` text for a fork says the branch will be pushed to `origin` (the fork).

- [ ] **Step 1: Write the failing test** `in a fork clone, new branches start from upstream/main`: sandbox with `origin` = a fork bare repo whose `main` is one commit behind, `upstream` = the canonical bare repo at URL `https://github.com/capybara-hq/core.git` (use `git config url.<local path>.insteadOf https://github.com/capybara-hq/core.git` so the URL matches while fetching locally); new worktree's HEAD equals upstream's `main`. Keep every existing test passing.
- [ ] **Step 2: Run** `pnpm exec vitest run tools/worktree`. Expected: new test FAILS.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm exec vitest run tools/worktree`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worktree): start new branches from the upstream main`.

### Task B4: Synced skills in core and their check

**Files:**
- Create: `tools/checks/src/synced-skills.ts`, `tools/checks/src/cli/synced-skills.ts`, `tools/checks/fixtures/synced-skills/{clean,edited}/.agents/skills/demo/{SKILL.md,extra.md}`
- Modify: `tools/checks/src/cli/all.ts` (add `{ name: "Synced skills", run: () => checkSyncedSkills(root) }`), `package.json` (script `check:synced-skills`)
- Create (by the sync command): `.agents/skills/{onboarding,contributing,reviewing-prs}/`
- Test: `tools/checks/test/synced-skills.test.ts`

**Interfaces:**
- Consumes: `skillHash` algorithm (A8), duplicated in `synced-skills.ts` with the same test vector `FIXTURE_SHA256`.
- Produces: `checkSyncedSkills(root: string): Finding[]`: for each `.agents/skills/*/SKILL.md` whose frontmatter `metadata.source` is `capybara-hq/.github`, recompute the hash over all files of that directory; mismatch → `{ rule: "synced-skill-edited", line: <line of sha256>, message: "edited in place: change it in capybara-hq/.github and run the sync command" }`; missing `version` or `sha256` → `synced-skill-metadata`. Skills without that source are ignored.

- [ ] **Step 1: Write the failing tests**: `clean fixture passes`; `edited fixture reports synced-skill-edited`; `hash of the A8 fixture equals FIXTURE_SHA256` (copy A8's fixture files into `tools/checks/fixtures/synced-skills/vector/`); `skills without the source are ignored`.
- [ ] **Step 2: Run** `pnpm exec vitest run tools/checks/test/synced-skills.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, register in `all.ts`.
- [ ] **Step 4: Sync and run**: in `/Users/grant/Capybara/dot-github`, `node src/sync/cli.ts --to <core worktree> --version v1.0.0`; then in core `pnpm check`. Expected: all checks pass, including "Synced skills".
- [ ] **Step 5: Commit** `feat(checks): verify synced skills` and `chore: sync shared skills v1.0.0` (two commits).

### Task B5: Gate caller and CODEOWNERS

**Files:**
- Create: `.github/workflows/community.yml`, `.github/CODEOWNERS`

**Interfaces:**
- Consumes: `gate.yml@v1` (A5).
- Produces: `community.yml`: `on: pull_request_target: [opened, edited, synchronize, reopened]`, `issues: [opened, edited, labeled, unlabeled, assigned, unassigned, closed, reopened]`, `issue_comment: [created]`; `permissions: { contents: read, issues: write, pull-requests: write, statuses: write }`; one job `uses: capybara-hq/.github/.github/workflows/gate.yml@v1`. A top comment states it must never check out the PR's code. `CODEOWNERS`: `* @capybara-hq/maintainers`.

- [ ] **Step 1:** Write both files.
- [ ] **Step 2: Verify** after the Part B PR is open: the PR itself (author has write access) gets `issue-linked` = success "Exempt: has write access" once the workflow is on `main`. `pull_request_target` runs the base branch's workflow, so the first real check is on the next PR after merge; Task C1 depends on that.
- [ ] **Step 3: Commit** `ci: call the shared issue gate and add CODEOWNERS`.

### Task B6: Docs in core

**Files:**
- Modify: `CONTRIBUTING.md`, `AGENTS.md`
- Delete: `.github/pull_request_template.md`

- [ ] **Step 1: `CONTRIBUTING.md`** (English): start with "How contributions work" pointing to the org guide (`https://github.com/capybara-hq/.github/blob/main/CONTRIBUTING.md`) and, for agents, `.agents/skills/contributing/SKILL.md`; then `pnpm doctor` / `pnpm verify`; keep the existing repository specifics (development environment, design first, changesets, live API tests, CLA note).
- [ ] **Step 2: `AGENTS.md`**: repository map adds `tools/dev` (`pnpm doctor` / `pnpm verify`) and notes that `.agents/skills/{onboarding,contributing,reviewing-prs}` are synced from `capybara-hq/.github` and must not be edited here; dependency chain adds `@capybara-hq/dev` (`tools/dev`, private) -> `@capybara-hq/ci`, and `@capybara-hq/worktree` -> `@capybara-hq/dev`; "How work is done" adds one line: the workflow (issues, PRs, review) is in the `contributing` skill; "CI and checks": required statuses are `ci-ok` and `issue-linked` (the latter from `community.yml`, not part of `ci-ok`), and the new `check:synced-skills` runs in full on PRs (part of `pnpm check`, cheap); common commands add `pnpm doctor`, `pnpm verify`.
- [ ] **Step 3: Run** `pnpm lint && pnpm typecheck && pnpm check`. Expected: PASS.
- [ ] **Step 4: Commit** `docs: point contributors to the shared workflow`; open the Part B PR. The PR description states that `check:synced-skills` runs in full (cheap, part of `pnpm check`).

## Part C: Rollout

### Task C1: Apply settings to core

**Timing:** only after `feat/m7-release` has been merged (maintainer's decision, 2026-10-23). Applying earlier changes the merge rules under the M7 PR (approval through bypass, branch must be up to date with `main`).

- [ ] **Step 1:** After the Part B PR is merged, open any small PR (for example the C2 smoke-test notes) and confirm it gets an `issue-linked` status.
- [ ] **Step 2:** `node src/settings/cli.ts check capybara-hq/core`; show the drift to the maintainer.
- [ ] **Step 3: Ask the maintainer**, then `node src/settings/cli.ts apply capybara-hq/core --prune` (replaces `protect-main`).
- [ ] **Step 4:** `check` again. Expected: no drift. Confirm on a PR: merge button requires approval and both statuses; the maintainer can merge their own PR through the bypass.
- [ ] **Step 5: Apply to `capybara-hq/.github` too** (ask first); it needs its own `CODEOWNERS` and gate caller first (one PR there).

### Task C2: Agent smoke tests

- [ ] **Step 1:** For Claude Code, Codex, Cursor and Copilot (whichever the maintainer has), in a fresh clone of core: does it read `AGENTS.md`; does it list `onboarding`, `contributing`, `reviewing-prs` and the domain skills; does it list any skill twice; can it run `pnpm doctor` and follow `onboarding` to green. Record agent, version, date, results.
- [ ] **Step 2:** Fill the "Supported agents" table in the org `CONTRIBUTING.md` (PR in `.github`). If a duplicate listing breaks behaviour, stop and ask the maintainer (spec §9).

### Task C3: Profile settings checklist for the maintainer

- [ ] **Step 1:** Give the maintainer the list: pin `core` (and later the plugins repository) on the org page; hide GitHub's suggested tasks; once DNS is on Cloudflare, add `capybarahq.com` under Verified and approved domains (TXT record) and switch the public email / contacts to the forwarding addresses (a follow-up PR in `.github`).
