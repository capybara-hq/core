# Environments, phase 1: the environment object and personal cloud environments

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. With more than five tasks, plan the waves first with the `wave-planned-subagent-development` skill (the wave table below is the starting point).

**Goal:** Conversations work in a person's own long-lived cloud environment instead of a sandbox
per conversation: picked before the model in the composer, shared by several conversations and
agents, with files that outlive the instance; providers move to `sandbox@2` and the sandbox images
are pulled from ghcr instead of built.

**Architecture:** A new kernel `environments` module owns the environment object (table
`environments`), its instance and file-system state (table `environment_instances`, which takes
over what `sandboxes` holds) and the IM default (table `environment_defaults`). `SandboxService`
keeps all lease, suspension and destruction logic but is keyed by environment id and drives
`sandbox@2`, whose file system has its own lifecycle. Tools resolve the root conversation's
environment (binding the owner's default on first use) before entering the sandbox. The web app
gets an environment picker slot in the design composer, an 环境 page and an environment line in
the properties panel. The plugins repository moves sandbox-docker and sandbox-e2b to `@2` and
publishes the images.

**Tech Stack:** NestJS kernel (Kysely on PG, Redis leases, BullMQ, `@Transactional`,
`@LockedCron`, `@Processor` + `runJob`), `@capybara-hq/plugin-sdk`, Next web app
(`@capybara-hq/design`, TanStack Query `defineQuery` / `useAppMutation`, next-intl), vitest;
plugins repo: Docker Engine API through the socket proxy, the E2B REST/envd client, GitHub Actions
with buildx.

**Spec:** `docs/superpowers/specs/2026-11-07-environments-design.md`. Phase 1 = §11 item 1:
§4 (all of 4.1 and 4.2 except connected and project parts), §5 (all), §7.4, §8.4 (ceiling only;
per-environment editing is not in phase 1), §9 for personal cloud environments, §10 for the tables
and errors listed below. Not in phase 1: §6 (connected devices), project environments, members,
audit rows, quotas, session isolation (no phase 1 provider declares it).

## Delivery order (three PRs, two repositories)

The plugins repository takes `@capybara-hq/plugin-sdk` and `@capybara-hq/testing` from npm, so the
contract lands in core first:

1. **PR A, core** (Tasks 1-16): SDK `sandbox@2`, kernel, testing, web, docs. After it merges, `main`
   refuses the bundled sandbox-docker (still `@1`) and sandboxes are unavailable on `main` until
   PR C; nothing is released, so this window is accepted. A core rc release publishes the SDK and
   testing packages.
2. **PR B, plugins** (Tasks 17-20): sandbox-docker and sandbox-e2b on `@2`, the image workflow,
   the provider skill. Its release publishes the plugins and the images.
3. **PR C, core** (Task 21): bootstrap pin, compose, live acceptance.

Waves inside PR A (tasks in one wave touch disjoint files):

| Wave | Tasks | Review |
|---|---|---|
| 1 | 1 (spec/docs), 2 (SDK), 4 (migration) | 4 alone (migration) |
| 2 | 3 (extension point majors), 5 (sandbox-fake), 12 (design composer slot) | batched |
| 3 | 6 (SandboxService by environment) | alone, most capable model (multi-replica) |
| 4 | 7 (lease simplification) | alone, most capable model (multi-replica) |
| 5 | 8 (environments service + API), 13 (fake-e2b) | 8 alone (cross-tenant access) |
| 6 | 9 (binding + tools + background), 11 (IM `/env`) | batched |
| 7 | 10 (per-session paths), 14 (web pages) | batched |
| 8 | 15 (composer + properties wiring), 16 (cleanup job, docs, changesets) | batched |

## Global Constraints

- Contract ref is exactly `sandbox@2`; the kernel accepts no other `sandbox` major.
- Names: file system and instance name `cap-env-<environmentId>`; legacy names `cap-<conversationId>`
  only in the cleanup job.
- Lock and lease keys keep their prefixes (`capk:sandbox:`, `capk:sandbox-users:`, …) with the
  environment id in place of the conversation id.
- Environment ids are `randomUUID()` text, like conversation ids.
- A personal environment is visible and usable only by its owner; any other caller gets
  `environment.not_found` (404), never `forbidden`, so ids cannot be probed.
- Error codes and statuses (`packages/kernel/src/errors.ts`): `environment.not_found` 404,
  `environment.forbidden` 403, `environment.unavailable` 503, `environment.files_lost` 409,
  `environment.name_taken` 409, `environment.limit_reached` 409. `sandbox.not_found` is removed
  (its only use, the per-conversation status route, goes away).
- Config: new `environments.maxPersonal` (integer, default 10, hot) under a new `environments`
  section; `sandbox.image` becomes optional with no default; descriptions of
  `sandbox.limits.destroyAfterInactiveDays` and the other per-conversation wordings are rewritten
  for environments; `pnpm gen:config-docs` regenerates `docs/config.md` (`check:config-docs`).
- Default environment: `name` is NULL and `is_default` true; the UI renders 「个人环境」 / "Personal",
  the IM phrases do the same. At most one live default per (org, account).
- Migrations: next number `0086`; `IF NOT EXISTS`; expand-only (the `sandboxes` table is not
  dropped in this plan).
- Kernel conventions (`check:kernel-conventions`): `@Injectable` with explicit `@Inject`,
  `@Transactional()` writes, enqueues in `afterCommit`, consumers under `WorkerModule`, queue names
  and job ids without `:`.
- Web: pages from design templates only, `defineQuery` with keys in `lib/query/keys.ts`,
  `useAppMutation`, every page in `routes.ts` and `APP_PAGES`, zh and en for every string, zh copy
  says 环境 / 云端沙箱 / 智能体 (never the Latin "agent", never 企业) (`check:web-ui`, `check:i18n`).
- Model-visible text is English. Tool definitions are replayed by spec hash, so no `DriftReason`;
  the zero-drift tests (`packages/kernel/test/evals/reconstruct.test.ts`,
  `packages/kernel/test/tools/rename-compat.test.ts`) pass before and after Task 10.
- SDK public API changes: `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`;
  changesets also for `@capybara-hq/kernel`, `@capybara-hq/testing`, `@capybara-hq/design`,
  `@capybara-hq/web` (fixed with `@capybara-hq/capybara`).
- Commits: Conventional Commits, body lines ≤ 100 characters.

## Review Focus

1. Two conversations of one person in the same environment run commands at the same time; a crash
   of one holder's replica kills only that holder's commands, never the other conversation's
   (Task 7, dual-replica test `crashed holder in a shared environment kills only its tags`).
2. An environment whose file system disappeared (Docker volume removed, E2B sandbox gone) never
   comes back as an empty workspace: tools fail with `environment.files_lost` and the page offers
   重建文件 (Tasks 6, 8, 17; tests `missing file system raises files_lost`).
3. A conversation started before the upgrade, and an IM thread, get the owner's default
   environment on their next sandbox call, and sub-agents use the root's environment (Task 9, test
   `unbound conversation binds the owner's default on first sandbox call`).
4. Deleting an environment while a conversation is mid-command waits for the exclusive lease, then
   removes the instance and the files; that conversation's next tool call gets
   `environment.not_found` (Task 8, test `delete waits for running commands then destroys both`).
5. Inactivity destroys only the instance; the next use recreates it on the same files and the tool
   result says files are kept (Task 6, test `inactive environment keeps files across rebuild`).

---

### Task 1: Spec and docs alignment

**Files:**
- Modify: `docs/superpowers/specs/2026-10-17-capybara-architecture-design.md` §8.3
- Modify: `AGENTS.md` ("Sandboxes" line)
- Modify: `.agents/skills/writing-sandbox-providers/SKILL.md`

- [ ] **Step 1:** §8.3: replace "Lazy creation on demand" and the per-conversation lifecycle with a
  pointer to the environments spec (environment = instance + file system; instance suspended and
  destroyed, files kept until the environment is deleted); `destroyAfterInactive` destroys the
  instance only.
- [ ] **Step 2:** AGENTS.md "Sandboxes" line: "work happens in environments (one instance + a file
  system kept until the environment is deleted); abort must kill the command; locking, suspension
  and destruction are the kernel's; never publish the socket proxy on a host address."
- [ ] **Step 3:** Rewrite the core writing-sandbox-providers skill for `@2`: file system vs
  instance lifecycle, `FileSystemGoneError`, required `concurrentExec` + `killTagged`, `killAll`
  only with no live holder, environment-keyed leases, optional `image`, `actor` on `exec`,
  `destroyFileSystemByName`, the legacy cleanup job. Keep the skill's description line accurate
  (it is what triggers it).
- [ ] **Step 4:** `pnpm check` (synced-skills and doc link checks pass). Commit
  `docs: describe environments in the architecture, AGENTS.md and the sandbox skill`.

### Task 2: SDK `sandbox@2`

**Files:**
- Modify: `packages/plugin-sdk/src/sandbox.ts`, `packages/plugin-sdk/src/skill.ts`,
  `packages/plugin-sdk/src/skill-invocation.ts`, `packages/plugin-sdk/src/index.ts`
- Test: `packages/plugin-sdk/test/sandbox.test.ts`, `packages/plugin-sdk/test/skill.test.ts`,
  `packages/plugin-sdk/test/skill-invocation.test.ts`
- Generated: the SDK API snapshot (`pnpm gen:sdk-api`); `.changeset/sandbox-v2-sdk.md`

**Interfaces:**
- Produces:
  - `SANDBOX_EXTENSION_POINT = "sandbox@2"`.
  - `interface FileSystemHandle { id: string }`.
  - `class FileSystemGoneError extends Error { readonly fileSystemGone = true }` and
    `isFileSystemGoneError(e: unknown): e is FileSystemGoneError` (duck-typed by `name` and flag,
    like `isSandboxGoneError`).
  - `interface SandboxActor { accountId: string; conversationId: string }`.
  - `interface SandboxProvider` with: `readonly concurrentExec: true`; `readonly sessionIsolation?:
    boolean`; `createFileSystem(args: { name: string; limits: SandboxLimits; signal: AbortSignal }):
    Promise<FileSystemHandle>`; `destroyFileSystem(fs: FileSystemHandle, signal): Promise<void>`;
    `destroyFileSystemByName(name: string, signal): Promise<void>`; `create(args: { name: string;
    image?: string; limits: SandboxLimits; fileSystem: FileSystemHandle; signal }):
    Promise<SandboxHandle>`; `destroy`, `destroyByName` (both required, instance only); `resume`,
    `suspend`, `readFile`, `writeFile`, `stat` unchanged; `killAll(h, signal)` and
    `killTagged(h, tags, signal)` required; `exec(h, args & { tag: string; actor: SandboxActor })`
    (`tag` now required).
  - `skillDigest(files: { path: string; size: number; sha256: string }[]): string` (12 hex: sha256
    of the files sorted by path as `${path} ${size} ${sha256}\n` lines).
  - `skillSandboxDir(name: string, digest: string): string` → `/skills/<name>@<digest>`;
    `skillSandboxPath(name, digest, path)` → `/skills/<name>@<digest>/<path>`.
  - `${CLAUDE_SKILL_DIR}` resolution and the invocation hint text take the digest
    (`skill-invocation.ts:151`, `:258`): the hint reads `call Skill with "<name>" to copy them to
    /skills/<name>@<digest>/`.

- [ ] **Step 1: Failing tests.** In `sandbox.test.ts`: `isFileSystemGoneError recognises a copy from
  another SDK instance` (a plain `Error` with `name = "FileSystemGoneError"` and
  `fileSystemGone = true` → true; a `SandboxGoneError` → false); `SANDBOX_EXTENSION_POINT is
  sandbox@2`. In `skill.test.ts`: `skillDigest is order independent and 12 hex` (same files in two
  orders → equal, matches `/^[0-9a-f]{12}$/`, changing one sha256 changes it);
  `skillSandboxPath includes the digest` (`skillSandboxPath("deploy", "0123456789ab",
  "run.sh") === "/skills/deploy@0123456789ab/run.sh"`). In `skill-invocation.test.ts`: the
  CLAUDE_SKILL_DIR case expects `/skills/deploy@<digest>`.
- [ ] **Step 2:** `pnpm exec vitest run packages/plugin-sdk/test` → the new cases fail.
- [ ] **Step 3:** Implement the interfaces above; rewrite the contract comment block for `@2`
  (file system lifetime, `create` must throw `FileSystemGoneError` rather than create an empty file
  system, `destroy` keeps files, `killAll` is called only when no other holder can be running,
  `actor` is informational in phase 1). Update callers of `skillSandboxPath` inside the SDK.
- [ ] **Step 4:** `pnpm exec vitest run packages/plugin-sdk/test` → PASS; `pnpm gen:sdk-api`;
  `pnpm check:sdk-api`.
- [ ] **Step 5:** Changeset (`@capybara-hq/plugin-sdk` minor: "sandbox@2: file systems outlive
  instances; skill paths carry a digest"). Commit `feat(sdk)!: sandbox@2 with separate file systems`.

### Task 3: Kernel accepts only supported extension point majors

**Files:**
- Modify: `packages/plugin-sdk/src/extension-point.ts` (info gains `majors`),
  `packages/kernel/src/extensions/resolve.ts`, `packages/kernel/src/sandbox/providers.ts`,
  `packages/kernel/src/extensions/permission-view.ts:89`, `packages/kernel/src/lifecycle/kernel-lifecycle.ts:256-265`
- Test: `packages/plugin-sdk/test/extension-point.test.ts`,
  `packages/kernel/test/extensions/extension-points.test.ts`

**Interfaces:**
- Consumes: `SANDBOX_EXTENSION_POINT` (Task 2).
- Produces: `EXTENSION_POINTS[name].majors: readonly number[]` (sandbox `[2]`; model-provider the
  majors the kernel adapts today, `[1, 2]`; every other point its current major); resolve error
  code `extension.unsupported_extension_point` with message
  `Plugin <plugin> provides <ref>, which this kernel no longer supports; upgrade it to a version that provides <name>@<max>.`

- [ ] **Step 1: Failing tests.** SDK: `every extension point lists its supported majors`.
  Kernel: `an extension providing sandbox@1 is refused at resolve` (a fake manifest with
  `provides: ["sandbox@1"]` → the resolve result marks it failed with
  `extension.unsupported_extension_point`, and `SandboxProviders.current()` is undefined).
- [ ] **Step 2:** Run both test files → FAIL.
- [ ] **Step 3:** Add `majors` to `info(...)` and check it in `resolve.ts` next to the
  single-provider check; `permission-view.ts` lists `sandbox@2`; `sandboxConfigWarnings` drops the
  "half-declared concurrentExec/killTagged" warning (both are required now) and the lifecycle log
  stays for the others.
- [ ] **Step 4:** Run → PASS. Commit `feat(kernel): refuse extensions on unsupported contract majors`.

### Task 4: Migration and schema types

**Files:**
- Create: `packages/kernel/src/migrations/0086_environments.sql`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (three tables, `ConversationsTable`,
  `BackgroundTasksTable`; `SandboxesTable` renamed `LegacySandboxesTable`, kept in
  `KernelDatabase` as `sandboxes` for the cleanup job only)
- Test: `packages/kernel/test/environments/migration.test.ts`

**Interfaces:**
- Produces:
  - `capybara.environments (id text PK, org_id text NOT NULL REFERENCES orgs ON DELETE CASCADE,
    owner_kind text NOT NULL CHECK (owner_kind IN ('personal')), owner_account_id text NOT NULL
    REFERENCES accounts, name text NULL, is_default boolean NOT NULL DEFAULT false, source text NOT
    NULL CHECK (source IN ('cloud')), provider text NULL, created_at, updated_at timestamptz NOT
    NULL DEFAULT now(), deleted_at timestamptz NULL)`; unique index
    `environments_default_uq ON (org_id, owner_account_id) WHERE is_default AND deleted_at IS NULL`;
    unique index `environments_name_uq ON (org_id, owner_account_id, lower(name)) WHERE name IS NOT
    NULL AND deleted_at IS NULL`. (The CHECK lists grow in phases 2 and 3 by new migrations.)
  - `capybara.environment_instances (environment_id text PK REFERENCES environments ON DELETE
    CASCADE, org_id text NOT NULL, provider text NULL, fs_handle jsonb NULL, fs_status text NOT NULL
    DEFAULT 'none' CHECK (fs_status IN ('none','ready','lost')), handle jsonb NULL, status text NOT
    NULL DEFAULT 'none' CHECK (status IN ('none','creating','running','suspended','destroyed')),
    last_used_at, running_since, created_at, suspended_at, destroyed_at timestamptz,
    generation integer NOT NULL DEFAULT 0, had_instance boolean NOT NULL DEFAULT false,
    prev_provider text, prev_handle jsonb, sweep_failed_at timestamptz)` with the three indexes of
    `0023_sandboxes.sql` re-created on it (`environment_instances_running_idx`, `_live_idx`,
    `_org_idx`).
  - `capybara.environment_defaults (org_id text, account_id text, environment_id text NOT NULL
    REFERENCES environments ON DELETE CASCADE, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, account_id))`.
  - `conversations.environment_id text NULL REFERENCES environments` (no cascade: a deleted
    environment is soft-deleted, the conversation keeps pointing at it).
  - `background_tasks.environment_id text NULL` plus index on `(environment_id) WHERE status =
    'running'`. Existing `running` rows are set to `lost` in the same migration (their sandboxes
    are destroyed by Task 16).
  - Kysely types `EnvironmentsTable`, `EnvironmentInstancesTable`, `EnvironmentDefaultsTable`.

- [ ] **Step 1: Failing test** `migration creates the environment tables and constraints`:
  migrate a test database; insert two live defaults for one account → unique violation; insert two
  environments named `Repo` and `repo` for one account → unique violation; a deleted default plus
  a live default → allowed; a `running` background task present before 0086 is `lost` after.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/environments/migration.test.ts` → FAIL.
- [ ] **Step 3:** Write the migration (follow the writing-migrations skill; the `UPDATE … SET status
  = 'lost'` needs no exemption, it is not destructive DDL) and the Kysely types.
- [ ] **Step 4:** Run → PASS; `pnpm typecheck` shows only the expected errors where code still uses
  `sandboxes` (fixed in Task 6). Commit `feat(kernel): environment tables`.

### Task 5: sandbox-fake on `@2`

**Files:**
- Modify: `packages/kernel/test/fixtures/plugins/sandbox-fake/index.ts`,
  `packages/kernel/test/helpers/plugin-packages.ts` (`sandboxFakePkg`), `packages/kernel/test/helpers/sandbox.ts`
- Test: `packages/kernel/test/sandbox/sandbox-fake.test.ts`

**Interfaces:**
- Consumes: SDK `@2` (Task 2).
- Produces: state layout `root/filesystems/<fsId>/{workspace,skills}` and
  `root/instances/<id>/{state,meta.json,tmp,procs,sessions}` (the instance mounts its file
  system's dirs); `meta.json` records `fileSystem`, `image` (or null), `limits`; `ops.log` records
  each `exec` with its `actor`; helpers `removeFakeFileSystem(root, fsId)`,
  `fakeFileSystems(root): string[]`, plus the existing exports.

- [ ] **Step 1: Failing tests:** `destroy keeps the file system` (write `/workspace/a`, destroy,
  create a new instance on the same file system, read `/workspace/a`); `create on a removed file
  system throws FileSystemGoneError`; `exec records its actor`;
  `destroyFileSystemByName removes a legacy-named file system`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; declare `concurrentExec: true`; `create` without `image` records
  `image: null`.
- [ ] **Step 4:** Run → PASS. Commit `test(kernel): sandbox-fake implements sandbox@2`.

### Task 6: `SandboxService` keyed by environment

**Files:**
- Modify: `packages/kernel/src/sandbox/sandbox.service.ts`, `packages/kernel/src/sandbox/jobs.ts`,
  `packages/kernel/src/config/schema.ts` (sandbox descriptions, `image` optional, `environments`
  section), `docs/config.md` (generated)
- Test: `packages/kernel/test/sandbox/sandbox.service.test.ts`, `lifecycle.test.ts`,
  `instance.test.ts`, `if-running.test.ts`, `limits.test.ts`, `sandbox.dual.test.ts`

**Interfaces:**
- Consumes: tables (Task 4), fake (Task 5).
- Produces (every `conversationId` parameter becomes `environmentId`):
  - `withSandbox<T>(ctx: { orgId: string; environmentId: string; holderConversationId: string;
    actor: SandboxActor }, fn: (h, p, info: SandboxUseInfo, signal) => Promise<T>, signal):
    Promise<T>`; `SandboxUseInfo = { fresh: boolean; restarted: boolean }` (`restarted` replaces
    `recreated`: a new instance on kept files).
  - `status(orgId, environmentId): Promise<{ status: "running" | "suspended"; lastUsedAt: Date } |
    null>`; `currentInstance(environmentId)`; `ifRunning(environmentId, instance, fn, signal?)`;
    `pathLease(environmentId, path, signal)`.
  - `destroyEnvironment(environmentId): Promise<void>` (replaces `destroyFor`; waits for the
    exclusive lease with intent, destroys the instance, then `destroyFileSystem`, then deletes the
    instance row).
  - `resetFileSystem(environmentId): Promise<void>` (exclusive lease; destroys any instance, drops
    a `lost` file system handle, sets `fs_status = 'none'`; the next use creates a new one).
  - `destroyInactive(now)` destroys the **instance** only (`status = 'destroyed'`, `fs_handle`
    kept); due when `last_used_at` is older than `destroyAfterInactiveDays`, or the org is deleted,
    or the environment row has `deleted_at` (then it calls the `destroyEnvironment` path).
  - `ensure` order: no file system → `createFileSystem({ name: cap-env-<id>, limits })`, store
    `fs_handle`, `fs_status = 'ready'`; then instance as today via `create({ name, image:
    cfg.image (omitted when unset), limits, fileSystem })`. `FileSystemGoneError` from `create` →
    set `fs_status = 'lost'` and throw `ApiError("environment.files_lost", "The environment's files
    are gone; reset its files from the environments page to start with an empty workspace.")`.
  - `fs_status = 'lost'` on entry → the same error without calling the provider.
  - Job `SANDBOX_DESTROY_FOR_JOB` data becomes `{ environmentIds: string[] }`;
    `SandboxJobs.destroy(environmentIds)`.
  - Instance name stays `cap-env-<id>`; `destroyRow` uses `destroyByName` for a handle-less
    instance and `destroyFileSystemByName` for a handle-less file system.

- [ ] **Step 1: Failing tests** (rewrite the existing suites around environment ids; keep their
  coverage) plus: `inactive environment keeps files across rebuild` (write a file, run
  `destroyInactive` past the window, next `withSandbox` reads the file and reports `restarted:
  true`); `missing file system raises files_lost` (`removeFakeFileSystem`, destroy the instance,
  next use → `environment.files_lost`, row `fs_status = 'lost'`, provider `createFileSystem` not
  called); `resetFileSystem starts an empty workspace`; `destroyEnvironment removes instance and
  file system`; `exec carries the actor` (fake `ops.log`).
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/sandbox` → FAIL.
- [ ] **Step 3:** Implement. Replace every `sandboxes` query with `environment_instances` (the
  `creating` insert becomes an upsert on `environment_id` that leaves an existing `fs_handle`
  alone), the seen key becomes `capk:sandbox-seen:<envId>:<holderConversationId>`, background
  `pendingKills` is read by environment id (Task 9 provides the store method; until then keep the
  call compiling against the new signature). Effective limits come from the environment's org
  exactly as today (`effectiveSandboxEgress`, `effectiveSandboxLimits`).
- [ ] **Step 4:** Regenerate config docs; run the sandbox suites → PASS (including
  `sandbox.dual.test.ts`). Commit `feat(kernel): sandbox leases and lifecycle keyed by environment`.

### Task 7: Lease simplification for shared environments

**Files:**
- Modify: `packages/kernel/src/sandbox/leases.ts`, `packages/kernel/src/sandbox/sandbox.service.ts`
- Test: `packages/kernel/test/sandbox/leases.test.ts`, `concurrent.test.ts`, `concurrent.dual.test.ts`

**Interfaces:**
- Produces: `sandboxConcurrency` removed (the cap is always `sandbox.maxConcurrentCommands`);
  `SandboxLeases` without `legacyMarker` and the `BUSY_V2` marker scripts; takeover kills dead
  holders with `killTagged` only; `killLeftovers` (`killAll`) runs only when the instance was just
  resumed from `suspended` or created, under the exclusive lease before downgrade.

- [ ] **Step 1: Failing tests:** `crashed holder in a shared environment kills only its tags`
  (dual-replica: conversation A and B hold shared leases in one environment, A's replica dies
  mid-command, B's next acquisition claims A and the fake records `killTagged([A's tag])`, B's
  running command survives, no `killAll`); `resume from suspended kills leftovers once`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Delete the single-holder branch (`asShared` `killAll` when `sharedCount <= 1`),
  the legacy busy marker machinery and its tests; keep fencing, intent, path leases and TTL rules
  of the writing-sandbox-providers skill unchanged.
- [ ] **Step 4:** Run the three files plus `pnpm exec vitest run packages/kernel/test/sandbox
  --maxWorkers=2` → PASS. Commit `refactor(kernel): sandbox leases assume concurrent providers`.

### Task 8: Environments service and HTTP API

**Files:**
- Create: `packages/kernel/src/environments/{environments.module.ts,environments.service.ts,environments.controller.ts,dto.ts,access.ts}`
- Modify: `packages/kernel/src/http/api.module.ts` (`CONTROLLERS`), `packages/kernel/src/errors.ts`,
  `packages/kernel/src/orgs/offboarding.ts`, `packages/kernel/src/agents/agents.service.ts`
  (remove `destroySandboxes` and its call), `packages/kernel/src/roles/worker.module.ts`
- Test: `packages/kernel/test/environments/environments.http.test.ts`,
  `packages/kernel/test/environments/access.test.ts`, `packages/kernel/test/orgs/offboarding.test.ts`

**Interfaces:**
- Consumes: `SandboxService.status / destroyEnvironment / resetFileSystem`, `SandboxJobs.destroy`
  (Task 6), `SandboxProviders.current()`.
- Produces:
  - `type EnvironmentView = { id: string; name: string | null; isDefault: boolean; ownerKind:
    "personal"; source: "cloud"; provider: string | null; available: boolean; sessionIsolation:
    boolean; filesLost: boolean; instance: { status: "running" | "suspended"; lastUsedAt: string }
    | null; limits: SandboxLimits; createdAt: string }` (`available` = its provider is the current
    one; `limits` = the org's effective limits).
  - `EnvironmentsService`: `list(orgId, accountId): Promise<{ items: EnvironmentView[]; defaultId:
    string | null; lastUsedId: string | null }>` (`lastUsedId` = `environment_id` of the account's
    most recently updated conversation that has one); `get(orgId, accountId, id)`;
    `create(orgId, accountId, { name }): Promise<EnvironmentView>`; `rename(orgId, accountId, id,
    name)`; `remove(orgId, accountId, id): Promise<void>` (sets `deleted_at`, clears a matching
    `environment_defaults` row, enqueues `SandboxJobs.destroy([id])` after commit);
    `resetFiles(orgId, accountId, id)`; `ensureDefault(orgId, accountId): Promise<string>`
    (idempotent under concurrency via the unique index: insert … ON CONFLICT DO NOTHING, then
    select; requires a current provider, else `environment.unavailable`).
  - `EnvironmentAccess.usable(orgId, accountId, environmentId): Promise<{ id: string; provider:
    string | null }>` — throws `environment.not_found` (missing, deleted, other owner, other org),
    `environment.unavailable` (provider not current). Phase 3 extends it with membership.
  - Routes (`@Controller("api/v1/orgs/:orgId/environments")`, all `@OrgAction("agents.use")`, all
    HUMAN_ONLY for writes): `GET /` → list; `POST /` `{ name: string (1-64, trimmed) }` → 201 view;
    `GET /:id`; `PATCH /:id` `{ name }`; `DELETE /:id` → 202; `POST /:id/files/reset` → 202.
  - Errors as in Global Constraints; `environment.limit_reached` when the account already has
    `environments.maxPersonal` live personal environments (the default counts).
  - Offboarding: replaces the sandboxes ⋈ conversations query with the leaving account's
    environments in that org: soft-delete them and `SandboxJobs.destroy(ids)`.

- [ ] **Step 1: Failing tests** (`environments.http.test.ts`): `create, list, rename, delete a
  personal environment`; `another member gets not_found for my environment` (GET, PATCH, DELETE,
  reset); `names are unique per person, case-insensitive` (`name_taken`); `limit_reached at
  maxPersonal`; `list reports defaultId and lastUsedId`; `delete waits for running commands then
  destroys both` (a command holding a shared lease; DELETE returns 202; after the job, the fake has
  neither instance nor file system and a tool call in that conversation returns
  `environment.not_found`); `reset files after files_lost`. `access.test.ts`:
  `ensureDefault is idempotent under concurrency` (ten parallel calls → one row);
  `unavailable when the provider changed`. Offboarding: `offboarding deletes the account's
  environments`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement following the writing-kernel-api skill (copy the shape of
  `packages/kernel/src/agents/pending-connectors.controller.ts`; DTOs via `createZodDto`).
- [ ] **Step 4:** Run → PASS; `pnpm check:kernel-conventions`. Commit
  `feat(kernel): environments API for personal cloud environments`.

### Task 9: Binding conversations, tools and background tasks to environments

**Files:**
- Modify: `packages/kernel/src/conversations/{conversations.controller.ts,conversations.service.ts}`
  (`CreateBody.environmentId`, `ConversationView.environmentId`, `createIn` binds),
  `packages/kernel/src/conversations/sandbox-status.ts` → rename to `environment-status.ts`,
  `packages/kernel/src/channels/inbound.ts` (bind at `create`),
  `packages/kernel/src/tools/builtins/sandbox/common.ts` (`inSandbox`, `withPathLease`),
  `packages/kernel/src/tools/builtins/sandbox/{bash.ts,task-output.ts}`,
  `packages/kernel/src/background/{store.ts,launch-lock.ts,tasks.service.ts,stop.ts,poll.job.ts}`
- Test: `packages/kernel/test/environments/binding.test.ts`,
  `packages/kernel/test/conversations/*.http.test.ts` (status route),
  `packages/kernel/test/tools/sandbox/sandbox-tools.test.ts`, `packages/kernel/test/background/*`

**Interfaces:**
- Consumes: `EnvironmentAccess.usable`, `EnvironmentsService.ensureDefault` (Task 8).
- Produces:
  - `POST /conversations` body gains `environmentId?: string`; absent → `ensureDefault` when a
    provider exists, else the conversation stays unbound. Present → `usable(...)` check before the
    insert.
  - `ConversationEnvironments.forTool(orgId, rootConversationId): Promise<string>` (in
    `environments/`): reads `conversations.environment_id` of the root; NULL → binds
    `environment_defaults` for IM-originated conversations (Task 11) else `ensureDefault` of the
    owner, written with `UPDATE … WHERE environment_id IS NULL` so a race binds once; then
    `usable(orgId, ownerAccountId, id)`. A conversation whose owner has no account (anonymous IM)
    → `sandbox.unavailable`.
  - `inSandbox` calls `forTool` then `withSandbox({ orgId, environmentId, holderConversationId:
    ctx.conversationId, actor: { accountId: ctx.accountId, conversationId: ctx.conversationId } })`;
    `mapSandboxError` maps the `environment.*` codes to actionable English tool errors (e.g.
    files_lost: "This environment's files are gone. Ask the user to reset its files on the
    environments page, then retry.").
  - `background_tasks.environment_id` is written at reserve; `ifRunning`, `pendingKills`,
    `countRunning` address the instance by environment id; `maxTasks` stays per root conversation
    (`sandbox_conversation_id` keeps meaning "root conversation").
  - `GET api/v1/orgs/:orgId/conversations/:id/environment` → `{ environment: EnvironmentView |
    null }` (replaces `/sandbox`; `null` when unbound; viewer access as before).

- [ ] **Step 1: Failing tests:** `unbound conversation binds the owner's default on first sandbox
  call`; `sub-agent uses the root's environment`; `two conversations share one environment's
  files` (A writes `/workspace/x`, B reads it); `create with another person's environmentId is
  not_found`; `background task status follows the environment instance`; `environment route
  returns the bound environment`; `anonymous IM conversation has no sandbox`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; update the existing sandbox-tool, background and conversation tests
  that assumed per-conversation sandboxes.
- [ ] **Step 4:** `pnpm exec vitest run packages/kernel/test/tools packages/kernel/test/background
  packages/kernel/test/conversations packages/kernel/test/environments` → PASS. Commit
  `feat(kernel): conversations and tools run in their environment`.

### Task 10: Per-session paths and notices

**Files:**
- Modify: `packages/kernel/src/tools/builtins/sandbox/common.ts` (`ATTACHMENTS_DIR`, sync marker,
  notices), `packages/kernel/src/tools/builtins/skill-load.ts` (paths, markers, `SPEC` text),
  `packages/kernel/src/tools/builtins/sandbox/{bash.ts,read.ts}` (description text),
  `packages/kernel/src/runtime/context/claude-tools.ts` (`CLAUDE_CODE_TOOL_MAP` last line),
  `packages/testing/src/index.ts` (re-exported notices)
- Test: `packages/kernel/test/tools/sandbox/{sandbox-tools,sandbox-helpers}.test.ts`,
  `packages/kernel/test/skills/{skills-runtime.test.ts,m5-segment3.dual.test.ts}`,
  `packages/kernel/test/sandbox/{concurrent.test.ts,sandbox-artifacts.dual.test.ts}`,
  `packages/kernel/test/evals/reconstruct.test.ts` (live cases at :810, :825, :975)

**Interfaces:**
- Consumes: `skillDigest`, `skillSandboxDir`, `skillSandboxPath` (Task 2).
- Produces:
  - `attachmentsDir(rootConversationId: string): string` →
    `/workspace/attachments/${rootConversationId.replaceAll("-", "").slice(0, 12)}`; the sync
    marker lives at `${attachmentsDir(id)}/.capybara-sync.json`.
  - Skill copies at `skillSandboxDir(name, skillDigest(manifest.files))`, markers at
    `/skills/.capybara/<name>@<digest>.json`; the Skill `SPEC` line reads "files, they are copied
    read-only to /skills/<name>@<version-id>/ in this environment; run scripts …"; result text
    `dir=/skills/<name>@<digest>/`.
  - Notices: `SANDBOX_STARTED_NOTICE = "Environment started (first use in this conversation); the
    working directory is /workspace, shared with the environment's other conversations."`;
    `SANDBOX_RESTARTED_NOTICE = "The environment's instance was restarted; files are kept, running
    processes and /tmp are gone."` (replaces `SANDBOX_RECREATED_NOTICE`; testing re-export
    renamed).

- [ ] **Step 1:** Run the zero-drift tests (`pnpm exec vitest run
  packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts`)
  → PASS (baseline).
- [ ] **Step 2: Failing tests:** `attachments of two conversations do not collide` (both upload
  `a.txt` into one environment → two directories); `two versions of one skill coexist` (copy v1
  and v2 → both dirs, both markers); `restart notice says files are kept`. Update the pinned path
  strings in the listed tests.
- [ ] **Step 3:** Run → FAIL. Implement. Run the listed tests → PASS.
- [ ] **Step 4:** Re-run the zero-drift tests → PASS (recorded fixtures unchanged). Commit
  `feat(kernel): per-conversation attachment and versioned skill paths in shared environments`.

### Task 11: IM default environment and `/env`

**Files:**
- Modify: `packages/kernel/src/channels/inbound.ts` (next to the `/new` check at :228),
  `packages/kernel/src/channels/phrases.ts`, `.agents/skills/writing-channels/SKILL.md` ("/new
  stays reserved" → "/new and /env are reserved")
- Test: `packages/kernel/test/channels/inbound.test.ts`

**Interfaces:**
- Consumes: `EnvironmentsService.list / ensureDefault`, table `environment_defaults` (Task 4).
- Produces: in direct messages only, `/env` (exact, case-insensitive) replies with the usable
  environments (default name rendered as 个人环境 / Personal, current IM default marked); `/env
  <name>` matches a usable environment by case-insensitive name (or 个人环境 / personal for the
  default), upserts `environment_defaults`, replies `envSwitched` ("下一个新对话将使用环境「{name}」，
  发送 /new 开始。" / "Your next new conversation will use the environment “{name}”; send /new to
  start one."); unknown name → `envUnknown` with the list. The thread's conversation is created
  with the IM default (`environment_defaults` row if still usable, else `ensureDefault`).

- [ ] **Step 1: Failing tests:** `/env lists environments in a direct message`; `/env <name> sets
  the IM default for the next thread`; `/env in a group is posted as a normal message`; `a new IM
  thread is bound to the IM default`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS. Commit `feat(kernel): /env picks the IM
  default environment`.

### Task 12: Design composer environment slot

**Files:**
- Modify: `packages/design/src/conversation/composer.tsx` (`ComposerBoxProps.pickers.environment?:
  PickerProps`, rendered after `agent` and before `model`), `docs/design/spec.md` §6.16.2 (slot
  order 智能体 · 环境 · 模型 · 档位, states: default, disabled item with hint, locked after first
  send), `apps/web/src/dev/catalog/components/chat.tsx` (catalog states with `RefBlock`),
  `packages/design/src/i18n.ts` if the slot needs design strings
- Test: `packages/design/test/composer.test.tsx`

**Interfaces:**
- Produces: `pickers: { agent?: PickerProps; environment?: PickerProps; model: PickerProps; effort?:
  PickerProps }`; a `locked` environment picker shows its value without a menu.

- [ ] **Step 1: Failing test:** `environment picker renders between agent and model` (DOM order of
  the three triggers) and `locked environment picker opens no menu`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/design/test/composer.test.tsx` → FAIL.
  Implement. Run → PASS.
- [ ] **Step 3:** Follow the writing-web-ui change flow for a component change (catalog states,
  compare and blind review, `ACCEPTED`); Linux baselines come from the `visual-update` workflow,
  never darwin PNGs. Commit `feat(design): environment picker slot in the composer`.

### Task 13: fake-e2b for the `@2` provider

**Files:**
- Modify: `packages/testing/src/fake-e2b.ts`
- Test: `packages/testing/test/fake-e2b.test.ts` (create it if missing)

**Interfaces:**
- Produces: pause with and without memory (a sandbox resumed after a memory-less pause has no
  processes but keeps files); the template build endpoints the `e2b@2.58.0` SDK's
  `Template.build(Template().fromImage(image), { alias })` calls (read the SDK's template build
  source for the exact routes and payloads; record them in the file header), with builds finishing
  after a configurable delay; `startFakeE2B({ templates?: string[] })` seeds existing aliases;
  `fake.removeSandbox(id)` to simulate a lost paused sandbox.

- [ ] **Step 1: Failing tests:** `template build from image becomes usable by alias`;
  `memory-less pause keeps files and drops processes`; `removed sandbox returns 404 on connect`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS. Commit `feat(testing): fake E2B builds
  templates and pauses without memory`.

### Task 14: Web environments pages

**Files:**
- Create: `apps/web/src/app/(app)/environments/{page.tsx,view.tsx}`,
  `apps/web/src/app/(app)/environments/[id]/{page.tsx,view.tsx}`,
  `apps/web/src/components/EnvironmentCreateDialog.tsx`, `apps/web/src/lib/environments.ts` (fetchers),
  `apps/web/src/lib/query/environments.ts`
- Modify: `apps/web/src/components/shell/nav.tsx` (entry after `connectors`: `{ id: "environments",
  key: "environments", href: "/environments", audience: "all", icon: "cpu", section: "primary" }`,
  `activeNavOf`), `apps/web/src/components/shell/path.ts` (`APP_PAGES`),
  `apps/web/src/lib/query/{keys.ts,routes.ts}`, `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/environments.test.tsx`

**Interfaces:**
- Consumes: the routes of Task 8.
- Produces: `environmentsQuery(orgId)` (key `keys.org(o).environments()`, freshness `live`),
  `environmentQuery(orgId, id)` (key `keys.org(o).environment(id)`, `live`); mutations create,
  rename, delete (`forgetsOnLeave` on the detail page), reset files, each invalidating
  `environments()` and `environment(id)`.
- Pages:
  - 环境 list: `ListPage variant="cards"`, one `ObjectCard` per environment: name (default →
    个人环境), 云端沙箱, state 运行中 / 已暂停 / 未启动 / 文件已丢失 / 不可用, 会话之间不隔离进程
    or 会话之间隔离进程. Primary action 新建环境 (hidden without a provider; then an `EmptyState`
    says the platform has no cloud sandbox and to ask the super admin).
  - 新建环境 dialog: one field 名称 (1-64), primary disabled until valid, on success navigate to
    the detail page.
  - Detail: `DetailPage`: summary (source, provider, isolation, limits, 文件保留到环境被删除,
    暂停会结束正在运行的进程), conversations count is not shown in phase 1; actions 重命名, 删除
    (typed-name confirmation, danger, text says files are deleted), and 重建文件 when `filesLost`.
  - zh/en keys under `environments.*` and `nav.environments` (环境 / Environments).

- [ ] **Step 1: Failing tests** (writing-web-ui per-page set): `environments list first render from
  hydrated cache makes no browser read`; `empty cache shows template loading, then cards`;
  `detail page …` (same pair); `create invalidates environments`; `delete invalidates environments
  and forgets the detail`; `reset files invalidates environment`; `no provider shows the empty state
  without 新建环境`.
- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/environments.test.tsx` → FAIL.
  Implement. Run → PASS; `pnpm check:web-ui`; `pnpm check:i18n`.
- [ ] **Step 3:** Commit `feat(web): environments pages`.

### Task 15: Composer picker and properties panel

**Files:**
- Modify: `apps/web/src/components/conversation/{NewConversation.tsx,useSelection.ts,ComposerBar.tsx,PropertiesSections.tsx}`,
  `apps/web/src/lib/conversations.ts` (`createConversationWithMessage` sends `environmentId`),
  `apps/web/src/lib/artifacts.ts` (`getSandboxStatus` → `getConversationEnvironment`),
  `apps/web/src/lib/query/{conversation.ts,keys.ts,routes.ts}` (`sandboxQuery` →
  `conversationEnvironmentQuery`, key `c.environment()`; `/chat` prefetches
  `environmentsQuery`), `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/new-conversation.test.tsx` (or the existing new-conversation test file),
  `apps/web/test/conversation-properties.test.tsx` (or the existing one)

**Interfaces:**
- Consumes: `environmentsQuery` (Task 14), slot (Task 12), routes of Tasks 8-9.
- Produces: the new-conversation page passes `pickers.environment` (items = usable environments,
  unavailable ones `disabled` with hint 不可用; initial value `lastUsedId ?? defaultId`; label
  环境); the send body carries `environmentId`; on an existing conversation the composer passes a
  `locked` environment picker; the properties `ContextSection` shows 环境: <name> · <state>
  instead of the sandbox line. With no provider the picker is omitted.

- [ ] **Step 1: Failing tests:** `new conversation sends the chosen environment`; `picker defaults to
  the last used environment`; `properties panel shows the conversation's environment`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS; `pnpm check:web-ui`; `pnpm check:i18n`.
- [ ] **Step 3:** Commit `feat(web): pick the environment before the model`.

### Task 16: Legacy cleanup job, docs and changesets

**Files:**
- Create: `packages/kernel/src/environments/legacy-cleanup.job.ts`
- Modify: `packages/kernel/src/roles/worker.module.ts`, `.changeset/*.md`
- Test: `packages/kernel/test/environments/legacy-cleanup.test.ts`

**Interfaces:**
- Produces: `@LockedInterval` job `environments-legacy-cleanup` (every 5 minutes, once per tick
  across replicas): reads up to 50 `sandboxes` rows, for each calls the row's provider (current,
  or `lookup(provider)`) `destroyByName("cap-<conversationId>")` and
  `destroyFileSystemByName("cap-<conversationId>")`, then deletes the row; a row whose provider is
  not loaded is kept and logged once per hour; with no rows left the tick is a cheap `SELECT … LIMIT
  1`. It runs no lease: legacy rows have no holders after the upgrade.

- [ ] **Step 1: Failing tests:** `legacy cleanup destroys old instances and volumes then deletes the
  rows` (seed rows and fake instances named `cap-<uuid>`); `rows of an unloaded provider are kept`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS.
- [ ] **Step 3:** Changesets: `@capybara-hq/kernel` minor, `@capybara-hq/testing` minor,
  `@capybara-hq/design` minor, `@capybara-hq/web` minor (environments, `sandbox@2`).
- [ ] **Step 4:** `pnpm verify --full` → green. Commit `feat(kernel): clean up per-conversation
  sandboxes`. Open PR A only after asking the maintainer.

---

## PR B: capybara-hq/plugins (after the core rc with Tasks 1-16 is on npm)

Pull `main` first (the local checkout was 29 commits behind at planning time). Bump
`@capybara-hq/plugin-sdk` and `@capybara-hq/testing` to the new rc.

### Task 17: sandbox-docker on `@2`

**Files:**
- Modify: `plugins/sandbox-docker/src/{index.ts,provider.ts}`, `plugins/sandbox-docker/README.md`
- Test: `plugins/sandbox-docker/test/{sandbox-docker.test.ts,concurrent.test.ts,manifest.test.ts}`

**Interfaces:**
- Produces: `createFileSystem({ name })` creates `${name}-workspace` and `${name}-skills` (with
  the `volumeDriver` size option as today) labelled `dev.capybara.sandbox.role=workspace|skills`,
  returns `{ id: name }`; `create({ name, image, limits, fileSystem })` inspects both volumes first
  (`GET /volumes/<name>`, 404 → `FileSystemGoneError`), then creates network, egress and container
  as today; `destroy` / `destroyByName` remove container, egress container and network, **not** the
  volumes; `destroyFileSystem` / `destroyFileSystemByName` remove the two volumes (force-removing a
  container still using them first). Default image `ghcr.io/capybara-hq/capybara-sandbox:<version>`
  and `egressProxyImage` default `ghcr.io/capybara-hq/capybara-sandbox-egress:<version>`, with
  `<version>` read from the plugin manifest's `version` (kept in sync by `capybara-plugin
  sync-versions`). `exec` accepts `actor` (ignored in phase 1).

- [ ] **Step 1: Failing tests** (real Docker, gated as today): `destroy keeps the volumes and a new
  instance sees the files`; `create on removed volumes throws FileSystemGoneError`;
  `destroyFileSystemByName removes legacy cap-<id> volumes`; `create without image uses the
  versioned default` (unit test on the resolved image string); manifest declares `sandbox@2`.
- [ ] **Step 2:** `pnpm exec vitest run plugins/sandbox-docker` → FAIL. Implement. → PASS (Docker
  available) and the unit tests PASS with `CAPYBARA_TEST_NO_DOCKER=1`.
- [ ] **Step 3:** README: file system vs instance, the image defaults, the offline route. Commit
  `feat(sandbox-docker)!: sandbox@2 with volumes that outlive containers`.

### Task 18: sandbox-e2b on `@2`

**Files:**
- Modify: `plugins/sandbox-e2b/src/{index.ts,provider.ts,e2b-api.ts}`, `plugins/sandbox-e2b/README.md`
- Test: `plugins/sandbox-e2b/test/{sandbox-e2b.test.ts,manifest.test.ts}`,
  `plugins/sandbox-e2b/test/live/sandbox-e2b.live.test.ts`

**Interfaces:**
- Produces: config `template` becomes optional; `createFileSystem` = ensure template, `POST
  /v2/sandboxes` (limits and network as `create` does today, metadata name), then pause without
  memory; returns `{ id: <e2b sandbox id> }`; `create(instance)` = connect (`{ timeout }`, the
  existing 409 retry), returns `{ id }` equal to the file system id; 404 on connect →
  `FileSystemGoneError`; `suspend` / `destroy` = pause without memory; `destroyByName` = pause the
  sandbox found by metadata name; `destroyFileSystem` / `destroyFileSystemByName` = kill.
  `sessionIsolation` is not declared in phase 1 (the per-session sandbox of spec §7.2 is a later
  enhancement). Template ensure: alias `capybara-sandbox-<tag with . replaced by ->`, look it up,
  else build from `image ?? ghcr.io/capybara-hq/capybara-sandbox:<version>` through the REST calls
  `Template.build` makes (as recorded in fake-e2b, Task 13), poll until ready, memoised per
  provider instance; concurrent builds of one alias are wasteful but correct.
- Live test additions (run only with `CAPYBARA_TEST_E2B_API_KEY`): file system survives instance
  destroy; template auto-build when `CAPYBARA_TEST_E2B_TEMPLATE` is unset; whether a paused
  sandbox's network rules can change (record the answer in the README's limits section, spec §5.3).

- [ ] **Step 1: Failing tests** against `startFakeE2B`: `files survive destroy and recreate`;
  `connect 404 throws FileSystemGoneError`; `missing template is built from the image once`;
  `pause drops memory`.
- [ ] **Step 2:** Run → FAIL. Implement. Run → PASS. Run the live test once with the key loaded
  from `~/.capybara-test.env` inside the command (never printed).
- [ ] **Step 3:** Commit `feat(sandbox-e2b)!: sandbox@2 on paused sandboxes, templates from the
  published image`.

### Task 19: Publish the images

**Files:**
- Create: `.github/workflows/images.yml`
- Modify: `tools/checks/test/workflows.test.ts` (cover the new file with the repo's workflow rules),
  `plugins/sandbox-docker/image/Dockerfile` header (points at the workflow)

**Interfaces:**
- Produces: on push to `main` touching `plugins/sandbox-docker/package.json` and on
  `workflow_dispatch`: read the sandbox-docker version; if `ghcr.io/capybara-hq/capybara-sandbox:<version>`
  exists, stop; else buildx `linux/amd64,linux/arm64` for `plugins/sandbox-docker/image` and
  `plugins/sandbox-docker/egress-proxy`, push both tags. Top-level `permissions: {}`, the job has
  `contents: read`, `packages: write`; actions pinned by SHA like the other workflows.

- [ ] **Step 1: Failing test** in `workflows.test.ts`: `images workflow pushes only with packages
  write and pinned actions`.
- [ ] **Step 2:** Run → FAIL. Write the workflow. Run → PASS. Commit `ci: publish the sandbox images
  to ghcr`.

### Task 20: Provider skill, changesets

**Files:**
- Modify: `.agents/skills/writing-sandbox-providers/SKILL.md` (plugins), `.changeset/*.md`

- [ ] **Step 1:** Rewrite the plugins skill for `@2` (same points as Task 1 step 3, from the
  provider side; minimum test coverage adds "destroy keeps files", "FileSystemGoneError",
  "destroyFileSystemByName").
- [ ] **Step 2:** Changesets: sandbox-docker and sandbox-e2b minor. `pnpm verify` green. Ask
  before opening PR B.

## PR C: core, after the plugins release

### Task 21: Pin, compose, acceptance

**Files:**
- Modify: `packages/kernel/bootstrap.json` (sandbox-docker pin and `marketplace.commit`),
  `docker/compose.yaml`, `docker/compose.dev.yaml`, `docs/deploy/*` where the sandbox images are
  described
- Create: `docs/superpowers/plans/environments-phase-1-live-acceptance-checklist.md`

- [ ] **Step 1:** Bump the pin; `pnpm check:bootstrap` and the compose ref checks pass.
- [ ] **Step 2:** Compose: profile `sandbox` keeps only `sandbox-proxy`; the two image build
  services move to profile `sandbox-build` with the comment "offline route: build the images
  locally and set CAPYBARA_SANDBOX__IMAGE and the plugin's egressProxyImage"; remove "(they are not
  published)".
- [ ] **Step 3:** Checklist: on a fresh deployment with only a Docker endpoint, the images are
  pulled; two conversations share files in 个人环境; a new environment from 新建环境 is picked
  before the model; suspension after 10 idle minutes keeps files; removing a volume by hand gives
  文件已丢失 and 重建文件 works; E2B with only an API key builds the template; `/env` in a Lark
  direct message.
- [ ] **Step 4:** `pnpm verify`. Commit `chore: pin sandbox@2 plugins and pull published images`.
  Ask before opening PR C.
