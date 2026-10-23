# AGENTS.md

Capybara: an open-source enterprise agent platform (TypeScript, pnpm monorepo, Apache-2.0). The kernel only does config, database, plugin hosting and HTTP; every capability is provided by a plugin.

## Repository map

| Path | What it is |
|---|---|
| `packages/plugin-sdk` | Plugin SDK: types and pure functions only; must not import any other `@capybara-hq/*` |
| `packages/kernel` | Kernel: config, db, `ctx`, plugin host, HTTP |
| `packages/testing` | Test containers and dual-replica helpers |
| `packages/design` | Web design system: tokens, components, page templates (spec: `docs/design/spec.md`) |
| `apps/capybara` | CLI |
| `apps/web` | Next web app (private; calls the kernel HTTP API through the `/api/*` proxy; must be started via `server.mjs`); pages are built only from `@capybara-hq/design` |
| `plugins/*` | Official plugins (`example-counter` is the reference implementation) |
| `tools/*` | Internal tools and custom checks |
| `tools/pack-plugin` | Plugin packer (`pnpm pack-plugin` / `pack-plugins`: esbuild into an npm-pack tgz with a static manifest) |
| `tools/release` | npm release tool (`pnpm release`: publish plan, skips versions already on npm, plugins as pack-plugin tgz); run by `.github/workflows/release.yml` |
| `tools/ci` | CI plan for a diff (`tools/ci/src/affected.ts`, run by the `changes` job) and `test-plugins.json` |
| `tools/worktree` | Worktree tool for starting work (`pnpm wt:new` / `wt:rm` / `wt:ls`), paired with `.claude/hooks/branch-safety.sh` |
| `tools/dev` | Contributor tools (`pnpm doctor:env` checks the environment, `pnpm verify` runs the required checks locally; private) |
| `docs/` | Design docs and plans |
| `.agents/skills/` | Agent-facing skills for working on this repo, read natively by Codex, Cursor, Copilot, Gemini CLI and others (`.claude/skills` symlinks here for Claude Code) |
| `.agents/skills/{onboarding,contributing,reviewing-prs}` | Synced from `capybara-hq/.github`: edit them there and run the sync; `check:synced-skills` rejects in-place edits |

## Three layers and dependency direction

Kernel / plugins / external apps. Dependencies only point downward:

- External apps -> the kernel HTTP API; never import kernel internals.
- Plugins -> only `@capybara-hq/plugin-sdk` and third-party npm packages; **never** `@capybara-hq/kernel`.
- Kernel -> implements the interfaces declared in the SDK.

The full package dependency chain (only these directions are allowed):

- `plugins/*` -> `@capybara-hq/plugin-sdk` (tests may also use the devDependency `@capybara-hq/testing`)
- `@capybara-hq/kernel` -> `@capybara-hq/plugin-sdk`
- `@capybara-hq/testing` -> `@capybara-hq/kernel` (`@capybara-hq/plugin-sdk` is a peerDependency)
- `@capybara-hq/capybara` (CLI, assembles the core image) -> `@capybara-hq/kernel`, `@capybara-hq/plugin-openai-compatible`, `@capybara-hq/plugin-object-store-s3` (the core image bundles only these two plugins, passed to the kernel as `builtinPlugins` with source `builtin`; the CLI resolves them by module path and does not import their code; every other plugin is installed as a plugin package into the plugin directory)
- `@capybara-hq/design` depends on no `@capybara-hq/*`
- `@capybara-hq/web` depends only on `@capybara-hq/design`, never on the kernel or other packages; it talks to the kernel only over HTTP (the "external app" layer)
- `tools/checks` -> `@capybara-hq/kernel` (devDependency: reads the config schema to generate docs, validates plugin packages); `tools/checks` -> `@capybara-hq/design` (devDependency, tests only: checks the template list); `tools/checks` -> `@capybara-hq/pack-plugin`, `@capybara-hq/plugin-sdk` (devDependency: `check:plugin-pack` packs the official plugins)
- `@capybara-hq/pack-plugin` (`tools/pack-plugin`, private) -> `@capybara-hq/plugin-sdk` (tests also use the devDependency `@capybara-hq/kernel` to validate the output)
- `@capybara-hq/release` (`tools/release`, private) -> `@capybara-hq/pack-plugin` (devDependency: packs the plugins it publishes)
- `@capybara-hq/plugin-sdk` depends on no `@capybara-hq/*`
- `@capybara-hq/ci` (`tools/ci`, private) depends on no `@capybara-hq/*` (CI runs it with plain `node`, before `pnpm install`)
- `@capybara-hq/dev` (`tools/dev`, private) -> `@capybara-hq/ci` (`pnpm verify` reuses the CI plan)
- `@capybara-hq/worktree` (`tools/worktree`, private) -> `@capybara-hq/dev` (remote detection)

Kernel, CLI and plugin tests use `@capybara-hq/testing` as a devDependency, in tests only. Tests outside a plugin that load an official plugin by path (e.g. kernel tests loading `plugins/todo/src/index.ts`) do **not** declare it as a devDependency; they list it in `tools/ci/test-plugins.json` instead (enforced by `pnpm check:test-plugins`). A devDependency would make pnpm treat the kernel as depending on the plugin: every plugin change would then pull in everything that depends on the kernel, it would add kernel -> plugin -> testing -> kernel cycles, and apps/web may depend only on design. `pnpm check:deps` only checks the plugin/SDK boundary; dependency direction for the kernel, CLI and web is not checked automatically yet and relies on review.

Package names are always `@capybara-hq/<name>`.

## Multi-replica discipline (production runs multiple replicas)

- `ctx` provides no timers and no in-process shared objects; periodic and delayed work goes through queues.
- Every `ctx.kv` write must have a TTL.
- State whose writer and reader may be in different requests or processes must not live in process memory (no in-process Maps, timers, local events); use Redis / PG.
- BullMQ queue names and job ids must not contain `:`.

## Rules at a glance

- Migrations: plain SQL files named `NNNN_<snake_desc>.sql`; creating or dropping objects must use `IF NOT EXISTS` / `IF EXISTS`; the kernel schema is `capybara`, a plugin's is `plugin_<name>` (`-` becomes `_`). See [.agents/skills/writing-migrations](.agents/skills/writing-migrations/SKILL.md).
- Config: env var prefix `CAPYBARA_`, nesting with double underscores (`CAPYBARA_DB__URL` -> `db.url`), env vars win; the source is chosen by `CAPYBARA_CONFIG_SOURCE` (`file` / `nacos`). See [.agents/skills/adding-config](.agents/skills/adding-config/SKILL.md). Plugin deployment config can also be stored in PG by an enterprise admin from the admin console (precedence: env > file / Nacos > PG > default; fields present in the startup config are read-only; invalid config = plugin pending configuration, never a kernel startup failure); see "two-level config" in [.agents/skills/writing-plugins](.agents/skills/writing-plugins/SKILL.md).
- Language: English is preferred for docs, code comments, identifiers and commit messages; Chinese is not required. Existing Chinese docs are migrated gradually. Model-facing text (prompts, tool descriptions, model-visible errors) is always English; UI text goes through i18n (zh and en).
- UI: page = template + design components; apps/web writes no styles (no className / style / .css / color literals). See [.agents/skills/writing-web-ui](.agents/skills/writing-web-ui/SKILL.md); enforced by `pnpm check:web-ui`.
- Plugins: see [.agents/skills/writing-plugins](.agents/skills/writing-plugins/SKILL.md); reference implementation `plugins/example-counter`. A plugin package is an npm-pack tgz (`pnpm pack-plugin` / `pack-plugins`; single-file ESM; only the SDK and zod are provided by the host; dynamic imports must be literals); validated by `packages/kernel/src/plugins/package.ts`.
- Kernel HTTP uses NestJS + Fastify: domain classes don't depend on Nest, constructor params use explicit `@Inject`; plugins don't depend on Nest. See [.agents/skills/writing-kernel-api](.agents/skills/writing-kernel-api/SKILL.md).
- Runtime: the conversation event log is the single source of truth; everything the model sees goes into the log (any model request can be reconstructed from the log plus the agent version), and the history sent to the model is append-only. Code lives in `packages/kernel/src/runtime`.
- Model provider plugins (including media blocks image / document: capability declarations, limits and placeholders are owned by the kernel; plugins never receive `ref`): see [.agents/skills/writing-model-providers](.agents/skills/writing-model-providers/SKILL.md).
- Tools (`ctx.tools`, descriptions and error text, default policy, output archiving, `tool_search`, drift review; the builtin `sandbox_*` tools and the skill tools `skill_load` / `skill_write`; keys contain no dots; `skill_write` always asks on shared agents, private agents don't ask by default and may set `skills.writePolicy: "ask"`): see [.agents/skills/writing-tools](.agents/skills/writing-tools/SKILL.md); reference implementation `plugins/todo`.
- Sandboxes (`sandbox@1`: abort must kill the command; throw `SandboxGoneError` only when certain the sandbox is gone; auto-start stopped instances; commands have a time limit inside the sandbox too; `killAll`; same-name replacement; `/skills` is read-only; `open` egress requires `allowOpenEgress`; locking, suspension and destruction are owned by the kernel `SandboxService`; never publish the socket proxy on a host address): see [.agents/skills/writing-sandbox-providers](.agents/skills/writing-sandbox-providers/SKILL.md); reference implementations `plugins/sandbox-docker`, `plugins/sandbox-e2b`.
- Object storage (`object-store@1` / `ctx.storage`: the key prefixes `plugins/<plugin>/<orgId>/` and `kernel/<orgId>/` are added by the kernel; presigned upload size must be enforced by the store; keys may not contain `${`; using `ctx.storage` requires declaring `permissions.storage`): see [.agents/skills/writing-object-store-providers](.agents/skills/writing-object-store-providers/SKILL.md); reference implementation `plugins/object-store-s3`.
- Connectors (remote service instances, formerly called "apps"; protocols are implemented by **connector plugins** providing `connector@1`, e.g. MCP / OpenAPI; stdio MCP is not supported): see [.agents/skills/writing-connectors](.agents/skills/writing-connectors/SKILL.md); reference implementations `plugins/connector-mcp`, `plugins/connector-openapi`.
- Channels, third-party login, directory sync (`channel@1` / `identity-source@1` / `directory@1`: identity key `<plugin>:<tenant>`, ack only after onEvent resolves, the card spec, no @everyone, long connections and leader election are owned by the kernel): see [.agents/skills/writing-channels](.agents/skills/writing-channels/SKILL.md); reference implementations `plugins/slack`, `plugins/lark`.
- Plugin UI (`ctx.ui`: right-panel tabs on the conversation page and "Extensions" pages; schema-rendered views don't gate loading, embedded apps require approval and are sensitive, tokens are valid only for their own plugin and never for `/api`): see [.agents/skills/writing-plugin-ui](.agents/skills/writing-plugin-ui/SKILL.md); reference implementations `plugins/todo` (views), `plugins/example-board` (embedded app).
- Evals and replay (trajectories, eval sets, step / full-run replay, judge): the event log is the single source of truth; run the zero-drift fixture tests before and after changing request building (`runtime/context/build.ts`, `model-call.ts`); any new model-visible input must go into the log with a matching `DriftReason`; full-run replay only uses recorded tool results and never executes tools; evals run on queue `cap-kernel-evals` with per-org concurrency and token caps. See [.agents/skills/replay-evals](.agents/skills/replay-evals/SKILL.md).
- Plugin packages and lifecycle: a plugin package is an npm-pack tgz; install / enable / disable / upgrade / uninstall never restart (desired state in PG + per-replica reconcile, per-instance ledger revocation, optional `dispose` and `ctx.signal`, in-flight calls drained within `pluginHost.drainSeconds`); plugin migrations are expand-only; plugins run in-process with full trust, so permission approval is governance, not a sandbox. See [.agents/skills/writing-plugins](.agents/skills/writing-plugins/SKILL.md).
- Enterprise directory and sources: four item kinds (plugin / connector template / skill / app), policy allow / needs approval / disabled; sources = the official catalog, enterprise catalogs, manual upload; the JSON Schemas for catalogs and app manifests live in `packages/plugin-sdk/schemas/` (generated by `pnpm gen:package-schemas`, drift-checked by `check:package-schemas`); downloads are always verified against the catalog's (or app lock's) sha512, never npm metadata.
- App bundles (`app.yaml`: plugins referenced by npm name + range + lock, inline connector templates, skills packed in; an org install only removes components it created that nothing else uses; upgrades are not supported in M6) and connector templates: see [.agents/skills/writing-apps](.agents/skills/writing-apps/SKILL.md).
- **When a rule can be checked automatically, the check is the authority**: `pnpm check` gathers the custom checks; every check has a test where a violating fixture makes it fail. A new check must be proven red first.

## Common commands

```bash
pnpm install
pnpm lint        # biome check
pnpm typecheck   # tsc -b
pnpm test        # vitest run
pnpm exec vitest run <path>   # a single test: run from the repo root (the root config adds the @capybara-hq/source condition dual-replica tests need); don't use pnpm --filter <pkg> exec vitest
pnpm check       # custom checks
pnpm wt:new <branch>   # start a task worktree (see "Branches and worktrees")
pnpm doctor:env  # check your environment (--json for machines; use pnpm -s for clean JSON)
pnpm verify      # run the required checks locally for the current branch (--json, pnpm -s)
docker compose -f docker/compose.dev.yaml up -d   # local postgres + valkey
```

## How work is done

- **Design before code for larger changes.** A new feature, a cross-package change, a new contract or a behavior change starts with a design doc in `docs/superpowers/specs/`, reviewed by a maintainer; then an implementation plan in `docs/superpowers/plans/` (tasks with files, interfaces, tests), also reviewed; then implementation against the plan. Small fixes skip this.
- Changes reach `main` only through pull requests; a maintainer merges.
- The contribution workflow (issues, claiming, PRs, review) is in the `contributing` skill (`.agents/skills/contributing/SKILL.md`) and the [org guide](https://github.com/capybara-hq/.github/blob/main/CONTRIBUTING.md).

## Branches and worktrees

- The Claude session runs in the main checkout, not in a separate window; the main checkout's HEAD stays on `main` so it is always a clean baseline.
- All task work happens in a worktree: `pnpm wt:new <branch> [--from origin/main] [--no-install]` creates `.claude/worktrees/<dir>` (gitignored; checks out the remote branch if it exists, otherwise creates it from `--from` (default `<upstream>/main`: `origin/main` in clones of capybara-hq/core, the upstream remote's main in fork clones) with `--no-track`; runs its own `pnpm install`). Work in that directory (cd into it or use absolute paths); after merge, `pnpm wt:rm <branch>` cleans up (the branch is kept). The branch name must be the first argument.
- `.claude/hooks/branch-safety.sh` (PreToolUse, wired in `.claude/settings.json`) enforces this: no pushes to `main`; no switching the main checkout to `feat/` `fix/` `docs/` `chore/` `test/` `refactor/` branches (worktrees are not restricted).
- Don't run the dev stack in two worktrees at once (`docker/compose.dev.yaml`, the kernel, `pnpm dev:web`): the ports collide; stop one before starting the other.

## CI and checks

- The required statuses are `ci-ok` and `issue-linked`. `ci-ok` aggregates every job in `.github/workflows/ci.yml`, which must all feed into it. `issue-linked` is set by `.github/workflows/community.yml` (the shared gate from `capybara-hq/.github`) and is not part of `ci-ok`.
- **PRs run what the diff affects; pushes to `main` run everything.** Cheap checks or checks that inherently look at the whole repo run in full on PRs too; expensive checks that can be scoped run only when affected. The plan is computed by `tools/ci/src/affected.ts` (rules unit-tested in `tools/ci/test`); keep this list, that file and the comments in `ci.yml` in sync:

  | Job | On PRs | Runs when |
  |---|---|---|
  | `ci`: `pnpm lint`, `pnpm typecheck`, `pnpm check` (all custom checks), plugin packing, commitlint | full | always |
  | `test` (vitest) | by diff | the changed workspace packages, everything that depends on them (any dependency kind, transitively), and every package whose tests load an affected plugin per `tools/ci/test-plugins.json`; `tools/checks` tests join every run (they read across the repo and take seconds). Passed to vitest as directory filters; 4 shards when `packages/kernel` is in the set, else 1 |
  | `web` (Next build) | by diff | `apps/web/**`, `packages/design/**` |
  | `visual` | by diff | `apps/web/**`, `packages/design/**` |
  | `e2e` | by diff | anything in the dependency closure of `apps/web`, `apps/capybara` (kernel, plugin-sdk, testing, the builtin plugins) and the plugins `apps/web/e2e` loads (`"apps/web/e2e"` in `test-plugins.json`) |

  - **Run everything** when the diff touches root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `vitest.config.*`, `tsconfig*.json`, `biome.json`, `.github/**`, `tools/ci/**`, `packages/testing/**`, any file that is neither a doc nor inside a workspace package (e.g. `docker/**`, `tools/fixtures/**`, `commitlint.config.ts`), or when the diff can't be computed.
  - **Docs-only** diffs (`docs/**` except `docs/config.md`, `*.md` outside packages, `.gitignore`, `.agents/**`, `.claude/**` except hooks and `settings.json`) skip test / web / e2e / visual.
  - Files outside packages that tests read are mapped in `EXTRA_INPUTS` in `affected.ts` (`.claude/hooks/**`, `.claude/settings.json` -> `tools/worktree`; `docs/config.md` -> `tools/checks`); add an entry when a new test reads such a file.
  - `check:synced-skills` (full: cheap, part of `pnpm check`): the synced skills under `.agents/skills/` must match the versions and hashes recorded from `capybara-hq/.github`.
  - `check:test-plugins` (full: cheap): a test outside a plugin that loads an official plugin by path or package name must have it as a dependency of its package or listed under its test root (`<package>/test`, `<package>/e2e`) in `tools/ci/test-plugins.json`, written as a literal path (no interpolated plugin names); stale entries fail too.
  - `check:compose-haproxy` (full: cheap, reads two files): the sandbox-proxy haproxy config inlined in `docker/compose.yaml` (`configs.sandbox-proxy-haproxy.content`, so the compose file works on a clean host) must match `docker/sandbox-proxy/haproxy.cfg` line for line, comments and blank lines aside, with every literal `$` written `$$`.
  - `check:release-metadata` (full: cheap, reads the workspace `package.json` files): every package that would be published (not `"private": true`) has a `description`, a `license` and `repository` `{ type: "git", url: "git+https://github.com/capybara-hq/core.git", directory: <its dir> }` (npm provenance rejects a mismatch); `packages/design`, `plugins/example-*`, `apps/*` and `tools/*` must be private.
- **npm release** (`.github/workflows/release.yml`, `pnpm release`): never on PRs; runs on push to `main` and on `workflow_dispatch`. A push with pending changesets opens / updates the "Version Packages" PR; a push publishes only when it changed the version of a published package (the merged Version Packages PR) and something is already on npm. The first release (0.1.0) is published only by a manual `workflow_dispatch`. Publishes the SDK, kernel and testing (`pnpm pack` then `npm publish`) and every `plugins/*` except `example-*` as the pack-plugin tgz, with `--provenance`, skipping versions already on npm.
- **Every new check must state whether it runs in full or by diff on PRs**, with the reasoning in the PR description, and update this section and the comments in `ci.yml`; on `main` everything always runs.
- **Flaky tests get fixed, not hidden behind retries.** Reproduce locally first by injecting a delay or adding load (`pnpm exec vitest run --maxWorkers=2`), then decide whether it's a test timing issue (wait for the full convergence condition instead of betting on one moment's state) or a product bug (fix the code and add a test). One "flaky" test once turned out to be a real lost-message bug.
- Visual baselines are generated only in the Playwright Docker image, via the `visual-update` workflow (see [.agents/skills/writing-web-ui](.agents/skills/writing-web-ui/SKILL.md)). The bot's baseline commit does not trigger PR checks; push an empty commit afterwards to rerun CI.

## Live API tests

- Tests that hit real services (model providers, E2B, MCP servers, Slack / Lark) run only when their `CAPYBARA_TEST_*` env vars are set; each skill lists the variables.
- Keep keys in a local env file outside the repo, load it only inside the test command, and never print it, paste it into a chat or commit it.
- Run the live tests after changing request mapping, protocol handling or upgrading a vendor SDK.
- A transient network error (e.g. `ECONNRESET`) is rerun once for that case before it is treated as a bug.

## Commits

Conventional Commits (checked by commitlint), body lines ≤ 100 characters; changes that affect a published package include a changeset (`pnpm changeset`).
