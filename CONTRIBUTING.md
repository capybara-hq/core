# Contributing

## Development environment

- Node 24, pnpm 10
- Start local dependencies: `docker compose -f docker/compose.dev.yaml up -d` (PostgreSQL 17 @ 5432, Valkey 8 @ 6379)
- After `pnpm install`, run `pnpm lint && pnpm typecheck && pnpm check && pnpm test`

Project conventions for people and coding agents alike are in [AGENTS.md](AGENTS.md); read it before your first change.

## Larger changes: design first

A new feature, a cross-package change, a new plugin contract or a behavior change follows three steps:

1. A design doc in `docs/superpowers/specs/`, reviewed by a maintainer.
2. An implementation plan in `docs/superpowers/plans/`: tasks with the files, interfaces and tests each one touches, also reviewed.
3. Implementation against the plan.

Small fixes can go straight to a PR. If you're unsure whether a change counts as "larger", open an issue first.

## Pull requests

- All changes reach `main` through pull requests; a maintainer reviews and merges.
- CI must be green; the required check is `ci-ok` (see "CI and checks" in AGENTS.md).

## Language

English is preferred for docs, code comments, identifiers and commit messages; Chinese is not required. Some existing docs are still in Chinese and are being migrated. UI text goes through i18n (zh and en).

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), e.g. `feat(kernel): add config loading`; body lines ≤ 100 characters. commitlint checks this on PRs.

## Changesets

If you change a package that is published, run `pnpm changeset` and commit the generated file.

## Live API tests

Some tests call real services and run only when their `CAPYBARA_TEST_*` variables are set (see the skills under `skills/`). Keep your keys in a local env file outside the repo, never print or commit them, and run the relevant live tests after changing request mapping or upgrading a vendor SDK.

## CLA

This project uses a Contributor License Agreement (CLA); a bot guides you through signing on your first PR. **External PRs are not merged until the CLA bot is live (milestone M7).** The CLA text will be published after legal review.

Whatever happens, the code is and will always remain open source under Apache-2.0.
