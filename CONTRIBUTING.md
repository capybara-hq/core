# Contributing

## How contributions work

Capybara uses one contribution workflow across the `capybara-hq` organization: issue, `accepted`, `/claim`, a pull request that closes the issue, review, and merge by a maintainer. Read the [organization guide](https://github.com/capybara-hq/.github/blob/main/CONTRIBUTING.md) first; this file only adds what is specific to this repository. If you use a coding agent, it can follow the same workflow from [.agents/skills/contributing/SKILL.md](.agents/skills/contributing/SKILL.md) (and start with the `onboarding` skill).

Two commands help at every step:

- `pnpm doctor:env` checks your environment (Node, pnpm, dependencies, Docker, remotes, git identity); `--fix` performs only fixes that need no decision.
- `pnpm verify` runs the required checks locally for your branch. Run it before pushing.

Both accept `--json`; run them as `pnpm -s doctor:env --json` so pnpm's banner does not precede the JSON.

Start a task in a worktree with `pnpm wt:new <branch>`; it branches from the upstream `main` (a fork's `upstream` remote, or `origin` for core developers).

## Development environment

- Node 24, pnpm 10
- Start local dependencies: `docker compose -f docker/compose.dev.yaml up -d` (PostgreSQL 17 @ 5432, Valkey 8 @ 6379)
- After `pnpm install`, run `pnpm lint && pnpm typecheck && pnpm check && pnpm test`

Project conventions for people and coding agents alike are in [AGENTS.md](AGENTS.md); read it before your first change. Task-specific guides live in [.agents/skills/](.agents/skills/) (`onboarding`, `contributing` and `reviewing-prs` are synced from `capybara-hq/.github` and must be edited there) (`.claude/skills` is a symlink to it). On Windows, enable symlinks before cloning (`git config --global core.symlinks true`, plus Developer Mode) or Claude Code won't find them.

## Larger changes: design first

A new feature, a cross-package change, a new plugin contract or a behavior change follows three steps:

1. A design doc in `docs/superpowers/specs/`, reviewed by a maintainer.
2. An implementation plan in `docs/superpowers/plans/`: tasks with the files, interfaces and tests each one touches, also reviewed.
3. Implementation against the plan.

Small fixes can go straight to a PR. If you're unsure whether a change counts as "larger", open an issue first.

## Pull requests

- All changes reach `main` through pull requests; a maintainer reviews and merges.
- CI must be green. The required statuses are `ci-ok` and `issue-linked` (the PR body must contain `Closes #N` for an accepted issue; see the organization guide and "CI and checks" in AGENTS.md).
- The PR description is filled from the organization's default template.

## Language

English is preferred for docs, code comments, identifiers and commit messages; Chinese is not required. Some existing docs are still in Chinese and are being migrated. UI text goes through i18n (zh and en).

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), e.g. `feat(kernel): add config loading`; body lines ≤ 100 characters. commitlint checks this on PRs.

## Changesets

If you change a package that is published, run `pnpm changeset` and commit the generated file.

## Live API tests

Some tests call real services and run only when their `CAPYBARA_TEST_*` variables are set (see the skills under `.agents/skills/`). Keep your keys in a local env file outside the repo, never print or commit them, and run the relevant live tests after changing request mapping or upgrading a vendor SDK.

## CLA

This project uses a Contributor License Agreement (CLA); a bot guides you through signing on your first PR. **External PRs are not merged until the CLA bot is live (milestone M7).** The CLA text will be published after legal review.

Whatever happens, the code is and will always remain open source under Apache-2.0.
