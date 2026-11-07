# AGENTS.md

Capybara: an open-source enterprise agent platform (TypeScript, pnpm monorepo, Apache-2.0). The kernel
only does config, database, extension hosting and HTTP; every capability is provided by an extension.

This file holds what every change needs. The detail lives next to its subject: the skill of the area
you touch (`.agents/skills/<name>/SKILL.md`, read it before changing that area), the specs under
`docs/superpowers/specs/`, [docs/architecture.md](docs/architecture.md) (full repository map and
dependency rules), [tools/checks/README.md](tools/checks/README.md) (every custom check) and
[tools/ci/README.md](tools/ci/README.md) (what CI runs when).

**Terms:** a **plugin** is the install and distribution unit (an extension, connector templates,
skills; npm `@capybara-hq/plugin-*`); an **extension** is the in-process code inside a plugin
(`defineExtension`, `ctx`, permissions); an **extension point** is a versioned contract
(`channel@1`); the **catalog** is what a deployment imported for orgs to install; a **marketplace**
lists importable plugins; "app" means only an external app calling the kernel over HTTP. The
deployment layer is the **platform**, run by the **super admin** (超级管理员; never "enterprise
admin"); an **org** sees the platform items on in it plus the items it owns. Data locations keep
their old names (`plugin_<name>` schemas, `/plugin-ui`, `/plugins/<name>/…` routes).

## Repository map

| Path | What it is |
|---|---|
| `packages/plugin-sdk` | SDK for plugins: types and pure functions; imports no other `@capybara-hq/*` |
| `packages/kernel` | The kernel: one NestJS + Fastify app (config, db, `ctx`, extension host, HTTP) |
| `packages/testing` | Test containers, dual-replica helpers, fake servers, fake extensions (`fixtures/extensions/*`) |
| `packages/plugin-tools` | The published plugin toolchain `capybara-plugin` (`pack`, `check`, `marketplace`, `release`, …) |
| `packages/design` | Web design system (spec `docs/design/spec.md`) |
| `apps/capybara` | CLI |
| `apps/web` | Next web app; talks to the kernel only over HTTP; pages built only from `@capybara-hq/design` |
| `plugins/model-fake` | The only plugin in core (scripted model for tests and trials); all other official plugins live in [`capybara-hq/plugins`](https://github.com/capybara-hq/plugins) |
| `tools/*` | Internal tools: `checks` (custom checks), `ci` (CI plan), `release`, `worktree`, `dev` |
| `docker/` | Compose files, Dockerfiles, sandbox proxy config, smoke tests |
| `.agents/skills/` | Agent skills (`.claude/skills` links here); `onboarding`, `contributing`, `reviewing-prs` are synced from `capybara-hq/.github`: edit them there |

## Dependency direction

Kernel / extensions / external apps; dependencies only point downward.

- External apps (including `apps/web`) -> the kernel HTTP API only. `apps/web` depends only on
  `@capybara-hq/design`.
- Extensions -> `@capybara-hq/plugin-sdk` and third-party npm packages, **never** the kernel. Nest
  stops at the extension boundary: an extension sees only the SDK `ctx`.
- `kernel` -> `plugin-sdk`; `testing` -> `kernel`; `plugin-tools` -> `plugin-sdk`, `kernel`;
  the CLI -> `kernel` only; `plugin-sdk` and `design` depend on no `@capybara-hq/*`.
- Tests use `@capybara-hq/testing` as a devDependency. Core tests load no official plugin except
  `model-fake`, listed in `tools/ci/test-plugins.json`, never as a devDependency
  (`pnpm check:test-plugins`).
- Package names are always `@capybara-hq/<name>`.

Every edge and the reason for it: [docs/architecture.md](docs/architecture.md). Only the plugin/SDK
boundary is checked automatically (`pnpm check:deps`); the rest relies on review.

## Multi-replica discipline (production runs multiple replicas)

- `ctx` provides no timers and no in-process shared objects; periodic and delayed work goes through
  queues. Every `ctx.kv` write has a TTL.
- State whose writer and reader may be in different requests or processes never lives in process
  memory (no in-process Maps, timers, local events); use Redis / PG.
- BullMQ queue names and job ids contain no `:`. One-off and delayed work is a BullMQ job with a
  deterministic id.
- Periodic kernel jobs are `@LockedCron` / `@LockedInterval` (once per tick across replicas), and
  they and every queue consumer are provided only under `WorkerModule`.
- Writes run in `@Transactional()` methods; enqueues, bus publishes and Redis calls happen in
  `afterCommit`, never inside the transaction. Distributed locks are `LockService` / `@WithLock`,
  never taken inside a transaction.

Details (tick gates, lock loss, `XactLock`, sub-agent waits, sandbox leases): the
[writing-kernel-api](.agents/skills/writing-kernel-api/SKILL.md) skill and the area skills.

## Rules by area

Each line is the rule you must not miss; the skill has the rest.

- **Language:** English for docs, code comments, identifiers and commit messages. When you touch a
  file, write new comments in English and translate the comments and test titles you edit (no bulk
  translation). Model-facing text is always English; UI text goes through i18n (zh and en); the zh UI
  says 平台 / 超级管理员 / 智能体, never 企业 or the Latin word `agent` (`pnpm check:i18n`).
- **Migrations:** plain SQL `NNNN_<snake_desc>.sql`, `IF [NOT] EXISTS`, applied files are immutable,
  kernel schema `capybara`, extension schema `plugin_<name>`.
  [writing-migrations](.agents/skills/writing-migrations/SKILL.md)
- **Config:** env prefix `CAPYBARA_`, nesting with `__`, env wins; extension deployment config may
  also live in PG (env > file / Nacos > PG > default); invalid extension config never fails startup.
  A deployment field may carry an org level (`orgAccess(schema, "readonly" | "override")`, `x-org`;
  no level = platform only, hidden): orgs follow the platform until they save a copy of the
  overridable fields, and every org-bound extension call carries the effective config for the org.
  [adding-config](.agents/skills/adding-config/SKILL.md)
- **Kernel:** standard Nest: `@Injectable` providers, one module each, explicit `@Inject` on every
  constructor parameter, config through `KernelConfigService`, DTOs via `createZodDto`
  (`pnpm check:kernel-conventions`). [writing-kernel-api](.agents/skills/writing-kernel-api/SKILL.md)
- **Web UI:** page = template + design components; apps/web writes no styles; every read is a
  TanStack Query `defineQuery`, every write `useAppMutation`; thin server `page.tsx` + client
  `view.tsx`; one box is enough: never a box inside a box (`web-ui-box-in-box` and the jsdom guard
  `findNestedBoxes`, both in [tools/checks/README.md](tools/checks/README.md))
  (`pnpm check:web-ui`); the new conversation is the workspace home at `/` (the setup layout while
  the org is not ready; `/chat` redirects there permanently with its query, maintainer decision
  2026-11-07), a conversation is `/chat/<id>`. [writing-web-ui](.agents/skills/writing-web-ui/SKILL.md)
- **Runtime and replay:** the conversation event log is the single source of truth; everything the
  model sees goes into the log, and history sent to the model is append-only; new model-visible
  input needs a `DriftReason`. Run the zero-drift fixture tests before and after changing request
  building. [replay-evals](.agents/skills/replay-evals/SKILL.md)
- **Extensions:** in-process, full trust (approval is governance, not a sandbox); lifecycle changes
  never restart; migrations expand-only; bootstrap plugins pinned in `packages/kernel/bootstrap.json`
  (required ones are `builtin`, the rest optional preinstalls, off in every org until switched on);
  hooks observe or deny, never rewrite; every kernel model call fires `model.request`, an
  extension's `ctx.models.embed` too (`purpose: "embedding"`, no conversation fields), and policy
  hooks fail closed. An extension call made for an org carries `config`, the
  effective config (platform deployment config plus the org's copy of overridable fields: never an
  overridable platform secret, hidden secrets stay); an org whose effective config is invalid gets
  no call (`needsConfig`); org admins may switch off single extension tools.
  [writing-extensions](.agents/skills/writing-extensions/SKILL.md)
- **Plugins and the catalog:** plugin tgz with `.capybara-plugin/plugin.json`; downloads always
  verified against recorded integrity; every admin-supplied URL goes through
  `packages/kernel/src/net`. A platform item's scope (`all` / `optional` / `named`; an org admin
  may switch `all` off too, only built-in items are fixed) decides where it
  is on; its skills, agent templates and connector templates are platform components, one version per
  deployment, never copied into orgs; an org-owned item reaches another org only through the share
  gate (`owner_org_id IS NULL OR shareable`). An agent template describes a whole agent: any member
  creates a private copy from it (a missing connector becomes a pending entry, a setup request goes
  to the org admins), org admins save agents as org templates; spec §15 of
  `docs/superpowers/specs/2026-11-05-plugin-component-management-design.md`. [writing-plugins](.agents/skills/writing-plugins/SKILL.md)
- **Platform tool:** a new HTTP route gets a Platform operation or an exclusion with a reason; operations call the controllers' services, never new logic (`pnpm check:platform-ops`).
- **Tools, sub-agents, web tools, skills:** English descriptions and actionable errors; tool keys
  contain no dots. [writing-tools](.agents/skills/writing-tools/SKILL.md)
- **Model providers:** no retries inside the extension; media limits and placeholders are the
  kernel's. A model has a kind (`ModelInfo.kind`, absent = `chat`); only `chat` (`stream`) and
  `embedding` (`embed`) are callable, other kinds are list-only. Models are enabled by default and
  disabled on demand by the platform and per org (the kernel refuses a disabled model for agents,
  purposes and `ctx.models`); calls made for an org carry `{ orgId, config }`. Extensions embed
  through `ctx.models.embed` (needs `permissions.models`, an org where the extension is enabled;
  recorded in `model_usage`, delivered by `usage.report` with purpose `embedding`). [writing-model-providers](.agents/skills/writing-model-providers/SKILL.md)
- **Sandboxes:** work happens in environments (one instance + a file system kept until the environment
  is deleted); abort must kill the command; locking, suspension and destruction are the kernel's;
  never publish the socket proxy on a host address.
  [writing-sandbox-providers](.agents/skills/writing-sandbox-providers/SKILL.md)
- **Object storage:** key prefixes are added by the kernel; presigned upload size enforced by the
  store. [writing-object-store-providers](.agents/skills/writing-object-store-providers/SKILL.md)
- **Connectors:** protocols are connector extensions (`connector@1`); no stdio MCP.
  [writing-connectors](.agents/skills/writing-connectors/SKILL.md)
- **Channels, login, directory:** ack only after `onEvent` resolves; long connections held only by
  the `gateway` role. [writing-channels](.agents/skills/writing-channels/SKILL.md)
- **Extension UI:** schema views or approved embeds; embed tokens never valid for `/api`.
  [writing-extension-ui](.agents/skills/writing-extension-ui/SKILL.md)
- **SDK public API:** changing it means `pnpm gen:sdk-api` plus a changeset bumping
  `@capybara-hq/plugin-sdk` (`check:sdk-api`, `check:sdk-api-changeset`).
- **Before 0.1.0:** no real users yet, so change formats, names and APIs directly; don't add
  compatibility layers for pre-release state. Applied migrations still stay immutable.
- **When a rule can be checked automatically, the check is the authority.** Every check has a test
  where a violating fixture makes it fail; a new check is proven red first.
  [tools/checks/README.md](tools/checks/README.md)

## Common commands

```bash
pnpm install
pnpm lint        # biome check
pnpm typecheck   # tsc -b
pnpm test        # vitest run
pnpm exec vitest run <path>   # a single test: from the repo root, not pnpm --filter <pkg> exec vitest
pnpm check       # custom checks
pnpm dev:kernel  # capybara start, pretty logs, copied to /tmp/capybara-dev-kernel.log
pnpm dev:web     # the web app, output copied to /tmp/capybara-dev-web.log
pnpm wt:new <branch>   # start a task worktree
pnpm doctor:env  # check your environment
pnpm verify      # the required checks for this branch; full-suite diffs run only the touched packages' tests (--full: all)
docker compose -f docker/compose.dev.yaml up -d   # local postgres + valkey
```

## How work is done

- **Design before code for larger changes.** A new feature, a cross-package change, a new contract
  or a behavior change starts with a design doc in `docs/superpowers/specs/`, reviewed by a
  maintainer; then a plan in `docs/superpowers/plans/`, also reviewed; then implementation. Small
  fixes skip this.
- **Executing a plan with subagents:** plan the execution before the first dispatch (waves of tasks
  with disjoint files in parallel, batched review and fixes per wave, trust-boundary / migration /
  multi-replica / cross-tenant tasks reviewed alone on the most capable model): the
  `wave-planned-subagent-development` skill, a layer on superpowers' subagent-driven-development.
- Changes reach `main` only through pull requests; a maintainer merges. The workflow is in the
  `contributing` skill and the [org guide](https://github.com/capybara-hq/.github/blob/main/CONTRIBUTING.md).

## Branches and worktrees

- The main checkout's HEAD stays on `main`. All task work happens in a worktree:
  `pnpm wt:new <branch> [--from origin/main] [--no-install]` creates `.claude/worktrees/<dir>`; work
  there; after merge, `pnpm wt:rm <branch>`. The branch name is the first argument.
- `.claude/hooks/branch-safety.sh` enforces it: no pushes to `main`, no switching the main checkout
  to `feat/` `fix/` `docs/` `chore/` `test/` `refactor/` branches.
- Don't run the dev stack in two worktrees at once: the ports collide.

## CI and checks

- Required statuses: `ci-ok` (aggregates every job in `.github/workflows/ci.yml`) and `issue-linked`.
  A PR need not be up to date with `main` to merge; the full run on `main` after each merge is the
  backstop (merge queue prepared but off: tools/ci/README.md).
- PRs run what the diff affects; pushes to `main` run everything. The plan is
  `tools/ci/src/affected.ts`, described in [tools/ci/README.md](tools/ci/README.md); keep that page
  and `affected.ts` in sync. Don't describe the plan or the checks in `ci.yml`: every edit to it
  reruns the whole suite.
- A new check states whether it runs in full or by diff on PRs, with the reason in the PR
  description, and goes into [tools/checks/README.md](tools/checks/README.md).
- **Flaky tests get fixed, not hidden behind retries.** Reproduce locally first (inject a delay, or
  `pnpm exec vitest run --maxWorkers=2`), then fix the test's wait condition or the product bug.
- Visual baselines and the design reference set are rendered only by their workflows
  (`visual-update`, `reference-update`); see [writing-web-ui](.agents/skills/writing-web-ui/SKILL.md).
- Releases (npm and images) run from `.github/workflows/release.yml`: [docs/deploy/release.md](docs/deploy/release.md).
  A change that only affects the images needs a changeset on `@capybara-hq/capybara`.

## Logs

When a dev kernel or the web app misbehaves, read `/tmp/capybara-dev-kernel.log` and
`/tmp/capybara-dev-web.log` first (`tail -n 200`, `grep reqId=<id>`, `grep context=<Class>`) before
guessing. Record format, the logger and tracing: [docs/development.md](docs/development.md#logs-and-tracing).

## Live API tests

- Tests that hit real services run only when their `CAPYBARA_TEST_*` env vars are set; each skill
  lists them. Run them after changing request mapping, protocol handling or a vendor SDK.
- Keep keys in a local env file outside the repo, load it only inside the test command, and never
  print, paste or commit it.
- A transient network error (e.g. `ECONNRESET`) is rerun once before it is treated as a bug.

## Commits

Conventional Commits (checked by commitlint), body lines ≤ 100 characters; changes that affect a
published package include a changeset (`pnpm changeset`).
