# Contributor workflow design

Date: 2026-10-23. Scope: how people (and whatever coding agent they use) contribute to the repositories of the `capybara-hq` organization, from first setup to a merged PR. Discussed with the maintainer on 2026-10-23; the predecessor in spirit is the Jira-based workflow of `octok-platform` (`.claude/commands/octok-*`), stripped of everything that existed only because of Jira, Bitbucket, batch releases and a shared `dev` branch.

Items marked **(designer's call)** were decided by the author of this document, not by the maintainer; everything else was stated by the maintainer in the discussion.

## 1. Why

- `capybara-hq/core` is public and meant to be built with the community. Today the only guidance is `CONTRIBUTING.md`, a Chinese PR template, `AGENTS.md` and the agent skills. There are no issue templates, no rule for when work may start, no rule for who approves merges beyond "a maintainer merges", and the existing tooling (`pnpm wt:new`, the `branch-safety` hook) assumes the person has write access and uses Claude Code.
- Contributors are unknown in advance and may use any tool: Claude Code, Codex, Cursor, Copilot, another agent, or none. Nothing may require a particular agent.
- Right after M7 all extensions move out of `core` into separate repositories (at least one plugins repository), also community-built. The workflow must be written once and shared, not copied per repository.

## 2. Goals, non-goals, anti-goals

**Goals**
1. One workflow for two kinds of contributors that differ only where they push (§3).
2. Community work starts from an issue a maintainer accepted; PRs without one are blocked automatically (§4).
3. Only the maintainer(s) approve and merge into `main`, enforced by repository settings that a script applies and verifies (§5).
4. Every repository offers the same two local commands, `pnpm doctor` and `pnpm verify`, so people and agents can check setup and run the CI gates locally (§6).
5. Agent skills that turn the workflow into plain-language actions for any agent that reads `.agents/skills/`: `onboarding`, `contributing`, `reviewing-prs` (§7).
6. Everything shared lives in `capybara-hq/.github`, versioned; `core` is the first consumer and the future plugins repository the second (§8).

**Non-goals (not in this project)**
- The CLA bot (already planned for M7; this design must not conflict with it).
- Splitting extensions out of `core`.
- AI review running on GitHub (an Action with the maintainer's API key). Review by agents happens locally, on the contributor's or the maintainer's machine.
- Release and publishing flow (changesets versioning, npm publish, tags).
- Merge queue, GitHub Discussions setup, automatic release of stale claims.
- Migrating the existing Chinese docs and skills to English.

**Anti-goals (failure even if it works)**
- Contributing requires a specific agent, or an agent at all.
- A workflow triggered by a PR from a fork checks out or executes the PR's code with write permissions or secrets.
- An agent pushes, opens a PR, posts a review or merges without the human it works for having said so.
- The maintainer's review agent runs code from a contributor's PR on the maintainer's machine (which holds keys such as `~/.capybara-test.env`) without the maintainer explicitly asking.
- Two copies of the workflow docs or scripts that drift apart (per repository, or per agent: no `.cursor/` / `.codex/` / `.github/skills` copies).
- The issue gate slows down core developers.

## 3. Two kinds of contributors, one flow

| | Core developer | Community contributor |
|---|---|---|
| Who | Member of the `capybara-hq` org, write access | Anyone with a GitHub account |
| Pushes to | branches in `capybara-hq/<repo>` (`origin`) | branches in their fork (`origin`); `capybara-hq/<repo>` is `upstream` |
| Starts from | anything (issue optional) | an issue labeled `accepted` and assigned to them (§4) |
| Base for new branches and for diffs | `origin/main` | `upstream/main` |
| CI on their PR | runs immediately | GitHub's default "approve and run" for first-time contributors |
| Merge | maintainer approves and merges | same |

Everything else is the same for both: worktree per task, design doc first for larger changes (existing `AGENTS.md` rule, reviewed by a maintainer), Conventional Commits, changesets, `pnpm verify` before pushing, PR with the template, review, changes, merge by a maintainer.

**Remote detection** (designer's call): the tools find "the upstream" as the remote whose URL points to `capybara-hq/<this repo>` (HTTPS or SSH). If that is `origin`, the person is working in the main repository (core developer); otherwise it is a fork clone and that remote is upstream (normally named `upstream`; any name works). If no remote points to `capybara-hq`, `pnpm doctor` reports it with the command to add one. `pnpm wt:new` uses `<upstream>/main` as its default `--from` and fetches that remote; new branches are still created with `--no-track` and pushed to `origin`.

The `branch-safety` Claude hook stays as an early warning for Claude Code users; it is not part of the enforcement (§5).

## 4. The issue gate

### 4.1 Issue entry
- Issue forms in `capybara-hq/.github/.github/ISSUE_TEMPLATE/`: `bug.yml` and `feature.yml`, English, with required fields (bug: what happened, steps to reproduce, expected behavior, version / commit, environment; feature: problem, proposed solution, alternatives considered). Both apply the label `needs-triage`. Forms apply their labels even when the author has no permissions.
- `config.yml` disables blank issues. Security reports go to private vulnerability reporting (enabled per repository by the settings script, §5) and `SECURITY.md`.
- A form in a repository's own `.github/ISSUE_TEMPLATE/` overrides the org default; `core` keeps none, so it uses the org forms (designer's call).

### 4.2 Labels as state
| Label | Meaning | Set by |
|---|---|---|
| `needs-triage` | new, not looked at | issue form, format check |
| `needs-info` | required sections missing or answer awaited | format check, maintainer |
| `accepted` | the maintainer wants this done; PRs may reference it | maintainer |
| `good first issue`, `help wanted` | accepted and open for the community | maintainer |

Rejected issues are closed as "not planned" with a one-line reason. The settings script creates and verifies these labels (and keeps GitHub's defaults such as `bug`, `enhancement`, `duplicate`).

### 4.3 Format check for issues opened without the form
Issues created through the API (by people or agents) bypass forms. A workflow on `issues: opened, edited` checks that the body has the sections of one of the forms (the `### <field label>` headings forms produce, with required ones not empty or `_No response_`). Missing sections: add `needs-info`, comment once with what is missing; when fixed, remove `needs-info` and keep `needs-triage`. Issues by org members are not checked (designer's call). Closing issues that stay in `needs-info` is a non-goal for now.

### 4.4 Claiming
An accepted issue is worked on by one person. A contributor comments `/claim` on an issue labeled `accepted`, `good first issue` or `help wanted`; a workflow on `issue_comment` assigns the commenter if the issue is unassigned, otherwise replies who has it (designer's call: `/claim` rather than "please assign me", so it works without a maintainer). GitHub allows assigning users who commented on an issue in a public repository; the implementation plan must verify this and fall back to a maintainer assigning if not.

### 4.5 The PR gate: `issue-linked`
A required commit status named `issue-linked` on every PR head (designer's call: a commit status set through the API rather than a job conclusion, so it can be re-evaluated when the issue changes without re-running CI):

- **Pass** when the PR author is exempt, or the PR body links an issue of the same repository with a closing keyword (`Closes #N`, `Fixes #N`, `Resolves #N`) and that issue is open, labeled `accepted` (or `good first issue` / `help wanted`, which imply it), and either unassigned or assigned to the PR author.
- **Exempt authors** (designer's call):
  - anyone with write, maintain or admin permission on the repository, read from the collaborator permission API. `author_association` is not used for this: GitHub reports org members whose membership is private as `CONTRIBUTOR` to `GITHUB_TOKEN`, which would block core developers. If the permission read fails, the gate fails with a message saying so rather than guessing;
  - bot accounts on an allowlist kept in the gate's config (initially `github-actions[bot]`, `dependabot[bot]`, `renovate[bot]`), so automated PRs such as a future changesets "Version Packages" PR are not stuck.
- **Fail** otherwise, with a description saying exactly what is missing, plus one PR comment (updated in place, not repeated) with the fix: open or find an issue, wait for `accepted`, `/claim` it, add `Closes #N`.
- **No exemptions** for small PRs: typo and docs fixes also need an accepted issue (maintainer's decision).
- **Re-evaluated** on PR `opened`, `edited`, `synchronize`, `reopened`, and on issue `labeled`, `unlabeled`, `assigned`, `unassigned`, `closed`, `reopened` (for open PRs that reference the issue).
- Runs from `pull_request_target` / `issues` events in the base repository's context. It **never checks out the PR's code**; it only reads the PR and issue through the API. Permissions: `statuses: write`, `pull-requests: write`, `issues: read`.
- The decision is a pure function (author association, PR body, linked issue state → pass / fail + message) in a small TypeScript module with unit tests, including fixtures that must fail (the `AGENTS.md` rule: a new check is proven red first). The workflow is a thin wrapper around it.

`AGENTS.md` currently says `ci-ok` is the only required check. That becomes: `ci-ok` is the only required CI check, and `issue-linked` is the only other required status (designer's call: keeping the gate out of `ci.yml` avoids re-running CI whenever a PR description is edited). When the CLA bot lands (M7), its status becomes a third required status through the settings script; until then the existing note in `CONTRIBUTING.md` stays: external PRs are not merged before the CLA bot is live. The gate and rulesets go live now, independent of the CLA (designer's call).

## 5. Who merges into `main`

Repository rulesets, applied and verified by a script in `capybara-hq/.github` (§8). The org is on GitHub Free: repository rulesets work for public repositories (`core` already has `protect-main`), organization-wide rulesets need Enterprise, so the script applies the same rulesets repository by repository.

- **Team** `@capybara-hq/maintainers`, initially only the maintainer (`grant-chao`). Every repository has `.github/CODEOWNERS` with `* @capybara-hq/maintainers`.
- **Ruleset `main-quality`** (no bypass): no deletion, no force push, changes only through PRs, required statuses `ci-ok` and `issue-linked`, branch must be up to date with `main` before merging (designer's call: with diff-based CI a stale base can hide a break; the cost is an extra "update branch" click).
- **Ruleset `main-review`**: 1 approval, code owner review required, approval of the most recent push required (a push after approval needs a new approval; matters because agents push), stale approvals dismissed. Bypass: the maintainers team in "pull request" mode only. While the maintainer is alone this is how their own PRs get merged (GitHub doesn't allow approving one's own PR); they still cannot push to `main` directly. Remove the bypass once the team has a second member.
- **Ruleset `main-merge`**: restrict updates to `main`, bypass for the maintainers team in "pull request" mode. Effect: only maintainers can press merge, and only on PRs that pass `main-quality`.
- Splitting into three rulesets keeps the bypass from also skipping CI (a bypass skips every rule of its ruleset) (designer's call).
- The existing `protect-main` ruleset on `core` is replaced by these. Allowed merge methods are left as they are today (merge, squash, rebase).
- The script also enables private vulnerability reporting and keeps "require approval for first-time contributors" at GitHub's default.

Applying the rulesets changes how merging works immediately, so the maintainer applies them deliberately (§10).

## 6. Local commands every repository provides

Each repository implements both as `pnpm` scripts. The shared skills rely on this contract only; what each command checks is the repository's business.

**Contract** (designer's call on the details):
- Exit code 0 when everything required passes, 1 otherwise.
- `--json` prints `{ "ok": bool, "checks": [{ "id", "title", "status": "pass" | "fail" | "warn" | "skip", "detail", "fix"? }] }` so agents don't parse prose; without it, a readable table.
- Never print secret values; report only whether a variable or file exists.
- Safe to run repeatedly; `doctor --fix` may perform fixes that need no decision (for example `pnpm install`), never anything that changes git state or touches the network beyond package installs.

**`pnpm doctor` in `core`**: Node 24 and pnpm 10; dependencies installed and matching the lockfile; Docker daemon reachable (tests start their own Postgres and Valkey containers); `.claude/skills` symlink resolves (Windows checkouts without `core.symlinks` turn it into a text file); remotes as in §3; git `user.name` and `user.email` set; `gh` installed and logged in (warn, not fail: only the skills and maintainers need it); optional: local Postgres / Valkey from `docker/compose.dev.yaml` reachable (needed for the dev stack, not for tests), live API test env file present (names only).

**`pnpm verify` in `core`**: the local equivalent of the required checks for the current branch. Base = merge base with `<upstream>/main`. Runs `pnpm lint`, `pnpm typecheck`, `pnpm check`, commitlint over the branch's commits, and vitest on the directories `tools/ci/src/affected.ts` selects for the diff (reusing the CI plan, not a second copy of the rules). Reports, without running, what CI will additionally run (web build, visual, e2e) (designer's call: those need the Playwright image or minutes of build and stay in CI). Warns when a published package changed and no changeset was added. Prints the plan before running.

## 7. Agent skills

Three shared skills, written in English (model-facing), kept in `capybara-hq/.github` and installed into each repository's `.agents/skills/` (§8). They describe intent, when to stop, and which command to run; logic stays in scripts and `gh`. Each sub-action is a target state, not a step: asking for "open the PR" first does whatever earlier steps are missing (idempotently), and stops only where a human must decide (borrowed from `octok-platform`). Every outward action (push, opening a PR, posting a comment or review) is shown to the user and done only after they agree, unless they already said to go ahead.

**`onboarding`** (anyone, first contact): runs `pnpm doctor --json`, explains each failing item and fixes what can be fixed with the user's consent, re-runs until required items pass, then gives a short tour: what the repository is (from `AGENTS.md`), which skill to read for which kind of change, the daily flow below, and open `good first issue` issues (`gh issue list`). Never prints or asks the user to paste secrets.

**`contributing`** (anyone, daily work), with these sub-actions, triggered by plain language:
- *start* from an issue number: check the issue is `accepted` (community) and claim it, then `pnpm wt:new <type>/<N>-<slug>` from upstream `main`; for larger changes, remind of the design-doc rule.
- *verify*: `pnpm verify`, explain failures.
- *open the PR*: first check what the GitHub-side gates will check, so the agent doesn't learn the rules from a red status: for community contributors, that the linked issue is still open, accepted and assigned to them (the `issue-linked` rule of §4.5, read through `gh`). Then Conventional Commits, changeset if needed, push to `origin`, `gh pr create --repo capybara-hq/<repo>` with the template filled and `Closes #N`. Before opening, an optional self-review: a fresh sub-agent (when the agent supports one; otherwise the agent itself) reads the diff against `AGENTS.md` and the relevant skills and lists problems for the contributor to fix; it never blocks.
- *address review*: read the PR's review threads, fix, `pnpm verify`, push, reply to each thread with what changed, re-request review.

**`reviewing-prs`** (maintainers, before merging), triggered by "review #N":
- Gathers the diff, description, linked issue and its labels, author association, CI and `issue-linked` status, through `gh` / the API, without checking out the PR into a working tree, installing its dependencies or running its code. Running anything locally happens only when the maintainer explicitly asks, and then never with live API env loaded.
- Checks the change against `AGENTS.md` and the skills for the areas it touches (dependency direction, multi-replica discipline, migrations, config, i18n, changesets, tests for new checks, and so on).
- Reports a verdict ("ready to merge" or a list of findings with file and line) and drafts a GitHub review with inline comments. Posts it (request changes or comment, or approve) as the maintainer only after the maintainer confirms. Never merges; the maintainer presses merge.

## 8. Where things live

Files in `capybara-hq/.github` are **not** part of a clone of `core`: org-wide default community files only take effect on github.com (the "Contributing" link, the "New issue" chooser, the PR form on the web), and reusable workflows are fetched by Actions at run time. So the split is by who reads a file:

- **Read only on github.com or by Actions** → lives only in `.github`, as an org default or a reusable workflow.
- **Read locally by people or agents** → its source lives in `.github`, and each repository carries a synced copy (below).

**`capybara-hq/.github`** (new public repository, the single source of the shared workflow):
- Org-wide defaults, used on github.com by every repository that has none of its own: issue forms (§4.1), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, designer's call), `SECURITY.md`, `pull_request_template.md` (English: what and why, linked issue, checklist: `pnpm verify`, changeset, design doc for larger changes), and `CONTRIBUTING.md`, the human-readable workflow of §3-§5.
- Reusable workflows (`workflow_call`): issue format check, `/claim`, `issue-linked`.
- `skills/onboarding`, `skills/contributing`, `skills/reviewing-prs`: the source of the shared skills (a plain `skills/` directory there, since the skills are that repository's product). `contributing` carries the workflow description and the PR body format agents use, so an agent never depends on the web-only template or guide.
- The settings script: desired state for labels, rulesets, CODEOWNERS presence and repository options; `apply <repo>` and `check <repo>` (check reports drift and exits non-zero).
- Its own CI running the unit tests of the gate logic, the settings script and the sync command.

**Versions** (designer's call, the usual convention for Actions): every release of `.github` gets an immutable tag `v1.x.y` and moves the major tag `v1`, both done by a workflow when a PR is merged into its `main` (so a release needs no separate maintainer step beyond reviewing and merging that PR). Consumer workflows call `@v1` and get compatible fixes without a PR; synced copies record the exact `v1.x.y`. A breaking change means `v2` and a PR in each consumer.

**Synced copies** (designer's call): one command in `capybara-hq/.github` copies the shared skills at a given version into a repository's `.agents/skills/<name>/`, recording source and version in each skill's frontmatter `metadata` with a note not to edit it there; updating is a normal PR in that repository. A copy is used rather than fetching at runtime because agents read local files and contributors may be offline. Whether `gh skill install` can replace the command is for the plan to check.

- Contributors never run the sync: the copies are committed files, so a clone already has them. Only a change to the shared skills needs a sync, done by a maintainer: merge the change in `.github` (which releases a version), run the command against each consumer checkout, open and merge one PR per consumer. Changes to workflows or web-only files need no sync.
- The command records a content hash with the version. Each consumer's `pnpm check` verifies the copies against their recorded hashes, offline, and fails with "edit the source in `capybara-hq/.github` and sync" when a copy was edited in place (designer's call).
- Opening the sync PRs automatically on each release needs a token that can write to other repositories (a GitHub App or PAT secret); a later step, not in this project.

**Each consumer repository** (`core` now, the plugins repository later):
- `pnpm doctor` and `pnpm verify` (§6), its `AGENTS.md` and domain skills.
- `.github/CODEOWNERS`, a workflow file calling the shared workflows `@v1`, the synced copies of the shared skills.
- A short `CONTRIBUTING.md` and a line in `AGENTS.md`, both pointing local readers to the `contributing` skill for the workflow and to the org guide on github.com; `core`'s `CONTRIBUTING.md` keeps its repository specifics (development environment, design-first rule, changesets, live API tests, CLA note). Note: a repository's own `CONTRIBUTING.md` hides the org default on github.com, which is why it must link to it.
- No PR template or issue forms of its own; `core` drops its Chinese `pull_request_template.md` (designer's call). Whether `gh pr create` picks up org default templates is for the plan to check; the `contributing` skill fills the body itself either way.

What stays inside `core` and is not shared: the diff-based CI plan (`tools/ci`), `test-plugins.json`, the custom checks, the worktree tool (each repository may ship its own; the contract is only `doctor` / `verify`).

## 9. Supported agents

The workflow must work without any agent. For agents, tier 1 is Claude Code, Codex, Cursor and GitHub Copilot; others are best effort. For each tier-1 agent the implementation records a manual smoke test (date, version): it reads `AGENTS.md`, it lists the skills from `.agents/skills/` (Claude Code through the `.claude/skills` symlink), it lists each skill once (open question from PR #15: Cursor reads both `.agents/skills` and `.claude/skills`), and it can run `pnpm doctor` and follow `onboarding` to a green result. Results go in a short table in the org `CONTRIBUTING.md`; this is not a CI check.

If an agent lists each skill twice (the likely case for Cursor), that is accepted and documented when the duplicates behave identically, since both paths point to the same files (designer's call). If it breaks behaviour, the fix is decided with the maintainer; removing `.claude/skills` or adding per-agent copies is not an option (§2).

## 10. Actions only the maintainer can take

These are outward-facing or change how the organization works; the implementation stops and asks before each:
- Creating the public repository `capybara-hq/.github` (the maintainer's `gh` token can).
- Creating the team `@capybara-hq/maintainers` (the token needs `admin:org`: the maintainer runs `gh auth refresh -h github.com -s admin:org`).
- Applying the rulesets to `core`, which replaces `protect-main` and immediately requires approval and `issue-linked` for merges.
- Publishing the contacts in `CODE_OF_CONDUCT.md` and `SECURITY.md` (§11).

## 11. Public contacts and promises

Decided by the maintainer:
- Contact for both `CODE_OF_CONDUCT.md` (enforcement) and `SECURITY.md` (reports): `284885069@qq.com`. In `SECURITY.md`, GitHub private vulnerability reporting is the preferred route and the email the alternative.
- Security response: a first reply (acknowledged, being assessed) within 2 days of a report. No fixed promise on time to fix; it depends on severity.
- Supported versions: before 1.0, only the latest release receives security fixes; fixes ship in the next release, no backports.

## 12. Left to the builder

- The exact wording of forms, templates, comments and skill text, within the rules above.
- How the gate workflows are implemented (`actions/github-script` or a checked-out copy of the `.github` repository's own scripts), as long as the PR's code is never checked out and the decision logic is a tested module.
- The JSON shape details of `doctor` / `verify` beyond §6, and where in `core` their code lives (a new `tools/dev` package or inside an existing tool).
- The order of work; a sensible one is: `.github` repository with community files and labels → `doctor` / `verify` and upstream detection in `core` → the gate workflows → the settings script and rulesets → the skills → updating `core`'s `CONTRIBUTING.md` and `AGENTS.md` (repository map, "CI and checks", required statuses) → agent smoke tests.
