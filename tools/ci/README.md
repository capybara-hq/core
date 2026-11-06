# CI plan

How `.github/workflows/ci.yml` decides what to run. The plan is computed by `tools/ci/src/affected.ts`
(rules unit-tested in `tools/ci/test`); keep this page, that file and the comments in `ci.yml` in
sync. The rules for each custom check are in [tools/checks/README.md](../checks/README.md).

- The required statuses are `ci-ok` and `issue-linked`. `ci-ok` aggregates every job in `.github/workflows/ci.yml`, which must all feed into it. `issue-linked` is set by `.github/workflows/community.yml` (the shared gate from `capybara-hq/.github`) and is not part of `ci-ok`.
- **PRs run what the diff affects; pushes to `main` run everything.** Cheap checks or checks that inherently look at the whole repo run in full on PRs too; expensive checks that can be scoped run only when affected. The plan is computed by `tools/ci/src/affected.ts` (rules unit-tested in `tools/ci/test`); keep this list, that file and the comments in `ci.yml` in sync:

  | Job | On PRs | Runs when |
  |---|---|---|
  | `ci`: `pnpm lint`, `pnpm typecheck`, `pnpm check` (all custom checks), packing model-fake and the fake extensions, commitlint; `pnpm check:bootstrap --network` when the plan's `bootstrap-network` output is true (see below) | full | always |
  | `test` (vitest) | by diff | the changed workspace packages, everything that depends on them (any dependency kind, transitively), every package whose tests load an affected plugin per `tools/ci/test-plugins.json`, and `apps/capybara` when `packages/kernel/bootstrap.json` or `packages/plugin-tools` changes (its tests pack fakes with the plugin packer and run `capybara bootstrap` on them); `tools/checks` tests join every run (they read across the repo and take seconds). A `model-fake` change runs its tests and the core tests that load it; a `packages/testing` change runs everything. Passed to vitest as directory filters; 6 shards when `packages/kernel` is in the set, else 1 |
  | `web` (Next build) | by diff | `apps/web/**`, `packages/design/**` |
  | `visual`: screenshot regression, measuring and state-coverage tests (`apps/web/visual/fidelity.spec.ts`: `/dev/ui/reference/<component>` against the size tables and state lists in `docs/design/spec.md`, plus a completeness case: `apps/web/visual/accepted.ts` lists every component with a state list; `apps/web/visual/skeleton-alignment.spec.ts`: for every template in `LOADING_TEMPLATES` (`accepted.ts`) each `data-part` shared by the loading and the loaded reference block has the same box within ±1 px, height too except the parts in `VARIABLE_HEIGHT`; interaction specs such as `apps/web/visual/sidebar.interaction.spec.ts` (keyboard paths, collapse motion and reduced motion, rail and drawer) and `apps/web/visual/conversation.interaction.spec.ts` (expand motion and reduced motion, panel exclusivity, the resize handle, the narrow sheet)) | by diff (builds Next and runs Playwright: minutes) | `apps/web/**`, `packages/design/**`, and `docs/design/{spec.md,tokens.json}` through `EXTRA_INPUTS`. The side-by-side page (`pnpm --filter @capybara-hq/web compare`) is a local review tool, not CI |
  | `e2e` | by diff | anything in the dependency closure of `apps/web`, `apps/capybara` (kernel, plugin-sdk, testing), the plugins `apps/web/e2e` loads (`"apps/web/e2e"` in `test-plugins.json`: model-fake), `packages/kernel/bootstrap.json` (the e2e setup's `capybara bootstrap` downloads and installs its npm pins); three jobs, each with its own stack and a third of the spec files (`--shard`) |
  | `docker`: builds the four images for linux/amd64 (loaded, never pushed), then `docker/test/compose-smoke.sh` | by diff (~15 min) | anything in the dependency closure of `apps/capybara` and `apps/web` (kernel, plugin-sdk, design, testing), `packages/kernel/bootstrap.json` (the compose init downloads its npm pins) and `plugins/model-fake` / `packages/plugin-tools` (the smoke test packs model-fake with it and installs it); `docker/**`, the Dockerfiles and `.dockerignore` belong to no package, so they run everything. Layer cache: GitHub Actions cache, written only on `main` |

- **Run everything** when the diff touches root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `vitest.config.*`, `tsconfig*.json`, `biome.json`, `.github/**` (except the files below that no PR check reads), `tools/ci/**`, `packages/testing/**`, any file that is neither a doc nor inside a workspace package (e.g. `docker/**`, `tools/fixtures/**`, `commitlint.config.ts`), or when the diff can't be computed.
- **Docs-only** diffs (`.github/CODEOWNERS` and the workflows `cla.yml`, `community.yml`, `merge-queue.yml`, `visual-update.yml`, `reference-update.yml` (`GITHUB_NO_TESTS`), `docs/**` except `docs/config.md`, `docs/design/spec.md` and `docs/design/tokens.json`, `*.md` outside packages, `.gitignore`, `.agents/**`, `.claude/**` except hooks and `settings.json`) skip test / web / e2e / visual / docker.
- Files outside packages that tests read are mapped in `EXTRA_INPUTS` in `affected.ts` (`.github/workflows/release.yml` -> `tools/release`; `.claude/hooks/**`, `.claude/settings.json` -> `tools/worktree`; `docs/config.md` -> `tools/checks`; `docs/design/tokens.json` -> `tools/checks`, `packages/design` and `apps/web`; `docs/design/spec.md` -> `packages/design` and `apps/web`; an entry may name several packages); add an entry when a new test reads such a file.

- **Every new check must state whether it runs in full or by diff on PRs**, with the reasoning in the PR description, and update this section and the comments in `ci.yml`; on `main` everything always runs.
- **Flaky tests get fixed, not hidden behind retries.** Reproduce locally first by injecting a delay or adding load (`pnpm exec vitest run --maxWorkers=2`), then decide whether it's a test timing issue (wait for the full convergence condition instead of betting on one moment's state) or a product bug (fix the code and add a test). One "flaky" test once turned out to be a real lost-message bug.
- Visual baselines are generated only in the Playwright Docker image, via the `visual-update` workflow (see [.agents/skills/writing-web-ui](../../.agents/skills/writing-web-ui/SKILL.md)). The bot's baseline commit does not trigger PR checks; push an empty commit afterwards to rerun CI.
- The design reference set (`docs/design/reference/*.png` and its review page `index.html`, rendered from `docs/design/reference/src` by `apps/web/reference`) is likewise rendered only by a manual workflow, `reference-update` (`workflow_dispatch` with the branch; never on PRs, not part of `ci-ok`), in the same Playwright image; see `docs/design/reference/README.md`.

## Merge queue (prepared, off)

`ci.yml` runs on `merge_group` and `merge-queue.yml` reports `issue-linked` on a merge group's
commit (`community.yml` sets it on PR heads only), so a GitHub merge queue can be turned on in the
`main-quality` ruleset. It is off: the queue admits a PR only once its code-owner review passed, and
with a single maintainer, who merges their own PRs by bypassing the `main-review` rule, nothing
could enter the queue, while the queue rule blocked every direct merge. Turn it on when a second
maintainer can review (or the review rule changes); until then PRs must be up to date with `main`.

The `changes` job decides "run everything" itself, before the plan script, when the diff touches
`tools/ci/**` or `.github/workflows/ci.yml`: those can change the plan, so the script is not
trusted to judge them. Every other `.github/` file goes to the script (`GITHUB_NO_TESTS`,
`EXTRA_INPUTS`).
