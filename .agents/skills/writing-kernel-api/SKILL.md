---
name: writing-kernel-api
description: 'Use when adding or changing kernel code wired into its Nest application, above all an HTTP API (controller, guard, DTO, error code): domain modules and @Injectable providers (one instance each), explicit @Inject on every constructor parameter, the one-convention-per-concern table (KernelConfigService, @Transactional + KernelDb + afterCommit, LockService / @WithLock, lock providers for pg_advisory_xact_lock, @LockedCron / @LockedInterval, @Processor + runJob, @Cacheable, throttlers, createZodDto with @ZBody / @ZQuery / @ZParam), the role modules (ApiModule / WorkerModule / GatewayModule), the start gate and the shutdown, default deny and the @Public list, @OrgAction and HUMAN_ONLY, registering error codes, where state lives under multiple replicas, and tests with app.get and the named test seams.'
---

# Writing kernel code and the kernel HTTP API

The kernel is **one standard NestJS application on Fastify** (spec `docs/superpowers/specs/2026-10-28-nest-kernel-design.md`; the decisions made during its implementation, cited below as "decision R<n>", are the spec's appendix "Decisions made during implementation", R1–R26 and N1–N10; the spec's status is implemented). Only the kernel uses Nest: **extensions never see Nest**; they get the SDK `ctx`, and extension routes are still `ctx.http.route(method, path, (req: Request) => Promise<Response>)` (see `.agents/skills/writing-extensions`).

Reference implementation: `packages/kernel/src/orgs/` (`orgs.module.ts`, `orgs.controller.ts`, `members.service.ts`, `org.guard.ts`, `org-lock.ts`).

## Modules and providers

```
createKernelApp(config, options) / startKernelApp(...)      (src/app.ts)
└─ KernelModule.forRoot(config, options)                    (src/kernel.module.ts)
   ├─ global infra (src/infra/*): ConfigModule (KernelConfigService), LoggingModule (KERNEL_LOGGER),
   │  GracefulShutdownModule, DatabaseModule (KernelDb, TransactionHost, XactLock), RedisModule
   │  (REDIS, KERNEL_BUS), LockModule (LockService), CacheModule, KernelEventsModule, QueueModule,
   │  KernelThrottlerModule, HealthModule, ValidationModule, ErrorFilterModule
   ├─ domain modules, one per directory (IdentityModule, OrgsModule, ToolsModule, …)
   ├─ role modules by `roles`: ApiModule (api), WorkerModule.forRoot (worker), GatewayModule (gateway)
   └─ KernelLifecycle: the start order and the stop phases (src/lifecycle/kernel-lifecycle.ts)
```

| Piece | Where | Rule |
|---|---|---|
| Domain service | `src/<domain>/*.ts` | `@Injectable()` class, provided by exactly **one** module (`kc-wiring` reports a class in two modules' `providers`); one instance per application. Pure functions stay plain functions |
| Domain module | `src/<domain>/<domain>.module.ts` | `@Module({ imports, providers, exports })`; imports the modules whose providers it injects, exports what other modules use. No `useFactory` / `useValue` for domain classes (`kc-wiring`; the few allowed tokens are listed in `KC_ALLOWED_FACTORY_TOKENS` of `tools/checks/src/kernel-conventions.ts`) |
| Controller | `src/<domain>/*.controller.ts`, listed in `CONTROLLERS` of `src/http/api.module.ts` | Parses parameters (DTOs), declares auth, calls services, sets cookies; business rules live in the service. `ApiModule` imports the controller's domain module |
| Infra token | `src/infra/tokens.ts` | Only for non-class values (`KERNEL_LOGGER`, `REDIS`, `KERNEL_BUS`, `KEYRING`, …); services are injected by class |

Cycles are cut by design, in this order (spec §3): move the shared part into its own provider both sides inject (e.g. `RunJobs`, the run queues' producer; `ChannelJobs`); else an in-process domain event on `KernelEvents` (`src/infra/events/kernel-events.ts`) for notifications that may be lost and are re-derived by a sweep (e.g. `run.orphaned`, `approval.decided`); `forwardRef` only from an allowlist with its reason (`kc-late-binding`), `ModuleRef.get` / `resolve` never outside `infra/`. No late-bound setters or closures filled in after construction.

The CLI uses the same providers through a Nest application context: `openKernelCli(config, { logger, modules: [AccountsModule], redis: false })` (`src/infra/cli/kernel-cli.module.ts`; `redis: false` leaves Redis and `LockService` out for PostgreSQL-only commands), so domain classes must not depend on request context.

## Constructor parameters must use an explicit `@Inject`

```ts
@Controller("api/v1/widgets")
export class WidgetsController {
  constructor(
    @Inject(WidgetsService) private readonly widgets: WidgetsService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}
}
```

Reason: the repo enables `experimentalDecorators` but **not `emitDecoratorMetadata`**; tsx / esbuild and Vitest emit no design-time type metadata, so Nest cannot see parameter types and a missing `@Inject` fails with "Nest can't resolve dependencies" at init. This holds for every `@Injectable`, `@Controller`, `@Processor`, `@Catch`, `@Module` class and guard (`kc-inject`); optional dependencies are `@Optional() @Inject(X)`. An entry point that runs the kernel with tsx must load the repo's `tsconfig.base.json` (root scripts use `--tsconfig tsconfig.base.json`), otherwise the decorators cannot compile.

## One convention per concern

Each concern is done one way; `pnpm check:kernel-conventions` (rules `kc-*`, listed in [tools/checks/README.md](../../../tools/checks/README.md)) rejects the removed patterns.

| Concern | Do | Never (rule) |
|---|---|---|
| Config | Inject `KernelConfigService`; call `get()` on every use (hot updates), `onChange` for appliers | pass `() => KernelConfig` closures (`kc-config`) |
| Transactions | `@Transactional()` on a provider method (it needs `txHost: TransactionHost`) and inject `KernelDb`, which resolves to the context's transaction or the pool; `propagation: "requires_new"` for an own transaction whose commit the caller relies on before notifying, `"mandatory"` for methods that rely on the caller's transaction or lock (throws outside one); side effects after the root commit with `afterCommit(fn)`: hooks run outside any transaction (also those of a `requires_new` nested in an outer one), a failing hook is logged and never fails the committed call, and outside a transaction the hook runs at once. Bus message handlers, jobs and timers start with no transaction and no inherited log context | `db.transaction()`, `trx` / `tx` parameters, `isTransaction` branches, a lock or an enqueue / bus publish / Redis call inside a `@Transactional` method (`kc-transaction`, `kc-lock-in-tx`, `kc-side-effect-in-tx`) |
| Row locking | `FOR UPDATE` / `FOR NO KEY UPDATE` / `FOR SHARE` inside the transaction | |
| Transaction-scoped advisory locks (decision R9) | `pg_advisory_xact_lock` is transaction semantics, like `FOR UPDATE`: only through `XactLock.lock(key)` inside a `@Transactional({ propagation: "mandatory" })` method of one small `*Lock` provider per lock (`OrgLock`, `SuperAdminLock`, `SetupLock`, `CatalogItemLock`, …) | session-level `pg_advisory_lock` / `pg_try_advisory_lock` outside the migration runners (`kc-lock`) |
| Distributed mutual exclusion | `LockService` (`acquire` / `run` / `lease` / `hold` / shared leases, Redis, renewed every TTL/3) or `@WithLock`; `acquire`, `run`, `hold`, `lease`, `tryShared` and `tryExclusive` throw inside a transaction; `lock.acquire_failed` (409, key in `details[0].lockKey`) when the wait runs out | hand-written `SET NX`, renewal timers (`kc-lock`) |
| Fixed-period jobs | `@LockedCron(expression, { name })`, or `@LockedInterval(name, (config) => ms, { runOnStart? })` for a config-driven period; the class has `lockService` and `log` (and `config` for intervals) and is provided only under `WorkerModule` | bare `@Cron` / `@Interval` (`kc-cron`), BullMQ repeatable schedulers, a job provider outside `WorkerModule` (`kc-worker-only`) |
| One-off and delayed jobs | `QueueModule.registerQueue(name)` + `@Inject(getQueueToken(name))`, deterministic job ids without `:`; `cap-kernel-maintenance` has one consumer, `MaintenanceProcessor`, which dispatches by name and also runs a periodic job's name once (`ScheduledRuns.runNow`, decision R23: no tick marker, no run lock) | `new Queue` / `new Worker` (`kc-queue`; extension queues behind `ctx.queue` are the exception) |
| Queue consumers | a `WorkerHost` with `@Processor(queue)` (or `configuredProcessor(Base, …)` when its options come from the config), provided only under `WorkerModule`; every job runs inside `runJob(queue, job, fn)` (fresh async context, log context) | `kc-queue`, `kc-worker-only` |
| Cache | `@Cacheable` / `@CacheEvict` (Redis, fail-open, keys prefixed `cache:`); inside a transaction `@CacheEvict` evicts after the COMMIT (nothing on rollback) and `@Cacheable` is bypassed (no read, no write: a cached value may be older than the transaction's own writes) | ad-hoc read-through Redis caches (`kc-cache`) |
| Rate limits | `@Throttled(...)` per route; credential routes `CredentialThrottler` (below) | hand-written counters (`kc-rate-limit`) |
| Validation | `createZodDto(schema, name)` with `@ZBody` / `@ZQuery` / `@ZParam` (below) | `new ZodPipe(`, `@Body()` / `@Query()` / `@Param()` typed with a DTO (`kc-zod-pipe`) |
| Logging | inject `KERNEL_LOGGER` (transient: each class gets a child with `context` = its class name) | module-level loggers (`kc-logger`) |
| Process handlers | only in `src/infra/lifecycle` | `process.on` anywhere else (`kc-process`) |
| Health | `HealthModule` (`/healthz`, `/readyz`, terminus) | other health routes (`kc-health`) |
| Entry point | `createKernelApp` / `startKernelApp`, services via `app.get(Class)` | a facade: `createKernel`, the `Kernel` type (`kc-facade`) |

Code ported from octok-platform starts with `// Ported from octok-platform <path> (owner-approved, 2026-10-28).` (`kc-ported-header`).

## Roles, start and stop

- `roles` selects the role modules: `ApiModule` (controllers, `AuthGuard`), `WorkerModule` (the schedulers, every `@LockedCron` / `@LockedInterval` job, every `@Processor`, `WorkerRole`), `GatewayModule` (channel supervisor, webhook inbound, `GatewayRole`). An `api`-only or `gateway`-only process builds no BullMQ worker and no scheduler; queue producers exist on every role. Health and the error filter are on every role.
- **Start** (`KernelLifecycle.onApplicationBootstrap`, spec §4): Redis, kernel migrations, the official marketplace, the bootstrap step (`LockService` lock `lock:bootstrap`, also taken by `capybara bootstrap`), the extension load, the worker parts (queue consumers, then the schedule gate opens), the gateway parts, extension routes, the lifecycle reconcile, the config watch. `listen()` runs only after `app.init()` resolved.
- **Start gate (decision R21)**: no scheduled tick (cron, interval, `runOnStart`) runs before `WorkerRole.start` opened the gate after the extension load; a tick that fires earlier logs INFO `cron skipped: the scheduler is not started` and claims nothing; `runOnStart` jobs run when the gate opens; the stop closes it again. Each tick runs once across replicas (a per-tick Redis marker plus the renewed run lock; another replica's tick logs INFO, not ERROR) in a fresh async context. A job body gets a `signal` that aborts at the stop or when its run lock is lost; only bodies that read it stop (the others are idempotent sweeps).
- **Stop**: `startKernelApp` installs its own `handleShutdownSignals` (`src/infra/lifecycle/shutdown-signals.ts`) instead of Nest's `enableShutdownHooks()`: the first SIGTERM / SIGINT starts the stop at once (readiness 503, a start in progress aborts at its next checkpoint), runs the stop phases (schedules, webhooks, runs, evals, channels, scheduled jobs, maintenance, titles, usage, channel outbound, extensions), closes the queues and workers (`QueueShutdown`: within what is left of the 30 s budget, `STOP_TIMEOUT_MS`, minus a 2 s reserve; one that cannot close, e.g. Redis down, is abandoned) and finally Redis and the pool, then exits 0 (1 on failure); a second signal exits 1 at once. `createKernelApp` installs no process-wide handler; stop it with `closeKernelApp(app)`.
- **Lost locks and leases (decisions R17 / R19)**: a `LockService` holder gives up at a deadline, the send time of its last successful renewal (or acquire) + TTL − TTL/3, even with a renewal in flight; `handle.lost` aborts and `LockService` logs one `lock lost: <key>` WARN. A lost conversation run lease aborts the run at the next step boundary (re-queued); a lost channel lease drops the connection. A failed release is logged at WARN (`lock release failed`; the key expires within its TTL).

## Auth: default deny

The global `AuthGuard` (`APP_GUARD`) requires credentials by default on **every** route (a Bearer API token, or the session cookie `cap_at`; whether a session is revoked is checked first by the Redis marker and then settled by PG `sessions.revoked_at`, so Redis data loss does not resurrect a revoked session); non-safe methods (POST / PUT / PATCH / DELETE) authenticated by cookie require the CSRF header `X-Capybara-Csrf: 1`, and Bearer is not checked. Account status is read live on every request, and a disabled account gets 403 `auth.account_disabled`. Stack decorators as needed:

| Decorator | Meaning |
|---|---|
| `@Public()` | Credentials not required (credentials, if present, are still parsed into a principal; when credentials are invalid, i.e. an `ApiError`, they are treated as absent, while other exceptions such as PG / Redis failures are still 500). Non-safe methods on public routes require `X-Capybara-Csrf: 1` whether or not a cookie is present |
| `@SessionOnly()` | Accepts only web sessions, such as token management and password change: a personal token -> 403 `auth.session_required`, a service token -> 403 `forbidden` |
| `@SuperAdmin()` | Allows only super admins; service tokens are always 403 |
| `@AllowService()` | Allows service tokens (a service principal is rejected by default) |
| `@OrgAction(action)` | Org-level route, see below |
| `@CurrentPrincipal()` | Parameter decorator, gets the principal; call `requireUser(p)` when a human user is needed |

**Adding a `@Public()` route must also update the `PUBLIC_ROUTES` list in `packages/kernel/test/identity/public-routes.test.ts`**, otherwise the meta test fails. This test enumerates all routes and requests each without credentials, ensuring no route is accidentally public; it also mounts a probe `APP_INTERCEPTOR`, and any route outside the list fails as soon as its handler is executed (the guard did not reject), so throwing `auth.required` yourself inside the handler cannot hide a mistaken `@Public()`. A public route must be a genuinely no-login entry point (login, refresh, invitation, setup), and rate limiting and enumeration attacks must be considered.

### Credential attempt rate limiting (`CredentialThrottler`)

Routes that check credentials inject `CredentialThrottler` (`src/infra/throttler/credential-throttler.ts`) and call it inside the handler, after pipes and preconditions: `reserve(names, req, reply)` atomically reserves one attempt on every named throttler **before** the credentials are checked (one Redis EVAL, all or nothing: a rejected attempt **increments no counter**), and `succeeded(names, req)` clears the `clear` counters and gives one attempt back on the `refund` ones. Over a limit → 429 `auth.rate_limited` with `Retry-After`. Fail-closed: a Redis error is a 500. The limits are the named throttlers in `src/infra/throttler/named-throttlers.ts` (900 s window, keys `throttler:{cred:<group>}:…`):

- Login `login`, `login-ip`, `login-account`: (login, IP) 10 attempts, IP 50, a single login across IPs 100. An attacker exhausting a login name from their own IP does not affect the real user logging in from another IP.
- Change password `change-password` (10 per account), `change-password-ip` (50, apart from the login IP quota); setup token `setup-token` (100 for the whole deployment), `setup-ip` (10); accept invitation `invitation` (10 per token), `invitation-ip` (20).

A new public entry point that checks credentials / tokens adds named throttlers (one group, one window) and calls `CredentialThrottler` the same way; plain per-route limits use `@Throttled(...)`.

### `@OrgAction` and `HUMAN_ONLY`

An org-level route must have `:orgId` in its path; declare the action and do not look up membership in the controller yourself:

```ts
@Patch(":orgId/members/:accountId")
@OrgAction("org.members.manage")
async changeRole(@CurrentPrincipal() p: Principal, @CurrentOrg() org: OrgContext, ...) {}
```

- Actions and their minimum roles are in `ACTION_MIN_ROLE` in `src/orgs/roles.ts` (guest < member < admin < owner); register new actions there.
- `OrgGuard` reads the org and role live from PG on every request: org nonexistent / deleted / caller not a member -> always 404 `org.not_found` (not revealing whether the org exists); insufficient role -> 403 `forbidden`.
- `@OrgAction` implies `@AllowService()`; actions in `HUMAN_ONLY` (all except `org.read`, `org.members.read` and `agents.use`) return 403 for a service token.
- **A role-dependent write must re-read the role inside the transaction**: the role may change between the guard's decision and the write. In the service's `@Transactional` method call `orgLock.lockAndAuthorize(orgId, actorAccountId, action)` (the `OrgLock` provider, `src/orgs/org-lock.ts`; `propagation: "mandatory"`, so it joins the caller's transaction and throws outside one): `SELECT … FROM capybara.orgs WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE` locks the org row, then reads the initiator's current role; org nonexistent / deleted -> 404 `org.not_found`, non-member or insufficient role -> 403 `forbidden`, and it returns `{ org, role }` for further checks (such as a token / invitation role not exceeding the initiator's). When you only need serialization and not the role, use `orgLock.lock` / `orgLock.tryLock`. Services accept only the initiator's account id, never a role passed in by the caller.
- **Super admin writes are the same** (`@SuperAdmin` is only a check at the start of the request): revoking / disabling an account, creating an account (including a super admin) and changing deployment settings all first call `adminLock.lockAndAuthorize(actorAccountId)` (the `SuperAdminLock` provider, `src/identity/super-admin.ts`; `mandatory`) inside the transaction: it takes the transaction-scoped lock `capybara.super_admins` (`XactLock`, `pg_advisory_xact_lock`, released at COMMIT; decision R9) to serialize and, inside the lock, confirms the initiator is still an active super admin, otherwise 403 `forbidden`. A new super admin write must do the same.
- **An admin demoting themselves is allowed**: `PATCH /orgs/:orgId/members/:self` (admin -> member / guest) succeeds as usual and writes an `org.member.role_changed` audit entry; only granting / revoking / changing an owner requires the initiator to be an owner, and no operation may leave an org without an owner (`org.last_owner`). After the demotion the account immediately loses `org.members.manage`, and later requests are decided live by OrgGuard.
- **A write that depends on "the membership still exists" locks the membership row first**: for example `PUT /me/current-org` in one transaction first takes `FOR SHARE` on the org row, then `SELECT … FROM memberships WHERE org_id = $1 AND account_id = $2 FOR SHARE` (querying only that one row), then writes the session; the lock order must match "remove member" (org row -> membership row), otherwise it deadlocks.
- **Catalog writes lock in one global order** (ruling P3-50): org rows (sorted by id) -> the catalog item (`CatalogItemLock`, its row) -> its component rows. An org deletion locks its org row, then the items it owns; `PlatformPluginUpdater.commit` locks every org it may write in (connector orgs, the owner org) before the item. A new path touching several of them follows this order, otherwise it deadlocks against an org deletion or a platform update.
- **Token expiry** uses the shared schema `FutureIsoDate` exported from `identity/api-tokens.ts` (a full ISO 8601 datetime string later than now; a number, `"2099-01-01"` and the like -> 400).
- **Org extension config** (`OrgExtensionConfigs`): `get` / `list` read config rows and secrets in a `REPEATABLE READ` read-only transaction; for an extension with `enabled=false`, `get` does not validate and returns `{ enabled: false, config: null }`; `put` clears, in the same transaction, the `capybara.secrets` rows for secret paths that no longer exist in the current schema; when never configured the `config` column stores NULL.

### Existing org actions (since M6)

`connectors.manage` (admin) / `connectors.use` (guest) are the connector actions after the D17 rename (formerly `apps.*`; HTTP `/api/v1/orgs/:orgId/connectors*`, error codes `connector.*`; no `/apps` alias and no compatibility layer, C28). M6 added:

| Action | Minimum role | Used for |
|---|---|---|
| `trajectories.read` | member | trajectory viewer; the service then decides "org admin or the agent's owner", eval conversations go only to org admins, and everything else is 404 |
| `evals.manage` | admin | eval sets, cases, runs, annotations |
| `org.models.manage` | admin | this org's model purpose mapping (`/model-purposes`) |
| `catalog.read` | member | the org's view of the catalog; the `POST catalog/:itemId/install` route and the upgrade routes (`POST plugin-installs/:installId/upgrade/preview`, `POST plugin-installs/:installId/upgrade`) need only this one, and the service re-checks inside the org row lock the actions of every plugin the install or upgrade touches (extension -> `org.extensions.manage`, connector templates -> `connectors.manage`, skills -> `skills.manage`, dependencies included) |
| `org.extensions.read` | member | the workspace "Extensions" page (`/extensions`): the extensions the org's plugins offer, without config, secrets or permissions |
| `catalog.request` | member | a member requests a catalog item |
| `catalog.decide` | admin | an org admin decides a member's request |

Agent templates and pending connectors (phase 4, spec §15; all human-only, no new action: the routes reuse these):

| Route | Action (minimum role) | Notes |
|---|---|---|
| `GET /agent-templates`, `GET /agent-templates/:id` | `agents.create` (member) | the templates usable in the org; one not usable -> 404 `component.not_found` |
| `POST /agents/from-template/preview`, `POST /agents/from-template` | `agents.create` (member) | a visibility other than `private` needs `agents.manage` (403 `agent.visibility_forbidden`); the create takes the `previewHash` (409 `agent.template_preview_stale`) |
| `POST /agents/:agentId/save-as-template`, `PUT` / `DELETE /agent-templates/:id`, `GET …/:id/delete-preview`, `PUT …/:id/shareable` | `agents.manage` (admin) | org templates only; owner-org admins; 409 `agent_template.name_taken` |
| `POST /agents/:agentId/pending-connectors/:key/bind`, `POST …/request` | `agents.create` (member) | the service then allows only the agent's owner or an org admin+ (re-read in the transaction) |
| `GET /agents/:agentId/pending-connectors/request` | `agents.use` (guest) | the service then allows only the agent's owner or an org admin+ (another member who sees the agent: 403 `forbidden`; anyone else: 404 `agent.not_found`) |
| `POST /connector-templates/:templateId/connectors` | `connectors.manage` (admin) | one more connector from a platform connector template |
| `POST /catalog-requests/:id/decide` on a `connector_setup` request | `catalog.decide` (admin) | rejecting only; configuring is a bind, and the request closes with the last one |

All of the above are in `HUMAN_ONLY` (403 for service tokens). Register new actions in `roles.ts` the same way and add a one-line comment stating the purpose.

Old audit records `app.*` are not rewritten; when querying audit by action use the explicit mapping in `auditActionAliases` (`identity/audit.ts`) to treat the old and new names as synonyms (do not guess by prefix). The 2026-10-24 terminology rename (`plugin.*` -> `extension.*`, `directory.*` -> `catalog.*`, `catalog.*` -> `marketplace.*`, bundle `app.*` -> `plugin.*`) has no aliases: rows written before it keep their old names.

### Super admin endpoints (`/api/v1/admin/*`)

Deployment-level endpoints always go under `/api/v1/admin/*`, with `@SuperAdmin()` on the controller (service tokens always 403), and are always called "super admin" (the path `/admin` is not renamed, C1; before migration 0080 the role was "enterprise admin"). A write first calls `adminLock.lockAndAuthorize` in its transaction (see above). Existing ones:

| Path | Controller | Content |
|---|---|---|
| `overview`, `accounts*`, `orgs`, `settings`, `models`, `model-prices`, `model-purposes*` | `admin/admin.controller.ts` | overview, accounts, orgs, deployment settings (`deployment_settings`: `orgCreation`, `runConcurrencyOverrides`, `sandboxLimitOverrides`, `priceCurrency`, `customConnectors`, `customSkills`), models, prices, the deployment default purpose mapping |
| `extensions*` | `admin/extensions.controller.ts` | extension list and details, deployment-level config (`:name/config`), approval, install / enable / disable / uninstall, package upload (`packages/file`) and npm import (`packages/npm`) |
| `catalog*` | `catalog/admin-catalog.controller.ts` | plugin import: prepare (`import/file`, `import/npm`, `import/git { url, ref?, path? }` -> `{ stagingId, review }`), reopen (`imports/:stagingId`), confirm (`imports/:stagingId/confirm`, always installs the extension); item list (`?pending=true` for 待确认) / details / icon / delete, scope (`items/:id/scope/preview`, `PUT items/:id/scope`), `PUT items/:id/disabled`, `PUT items/:id/shown`, `POST items/:id/confirm`. The web pages are `/admin/plugins/**` and `/admin/extensions` |
| `catalog/requests*` | `catalog/org-catalog.controller.ts` | requests (kinds `access` / `import` / `enable`: `POST orgs/:orgId/catalog/:itemId/requests`, `POST …/marketplace-requests`, `catalog-requests/:id/decide` / `dismiss`, the super admin's list and decide); the org plugin switch (`PUT orgs/:orgId/catalog/:itemId/switch`); the org's read-only marketplace entries (`marketplaces.controller.ts`, behind `orgMarketplaceBrowse`). The web pages are `/plugins/**` and `/extensions` |
| `marketplaces*` | `catalog/marketplaces.controller.ts` | create / update / delete official / custom marketplaces (http or git: `form`, `ref`; `PATCH` takes `ref: null`), refresh, browse entries (`entries`, one row per entry version), prepare an import from a marketplace (`:id/entries/:name/import { version? }`, confirmed through the catalog route) |

- Super admins **cannot read conversations** by default: trajectories and evals go only to org admins and agent owners (C1); do not add endpoints under `/admin` that read conversation content.
- The package upload route takes raw bytes (`application/octet-stream`, limit `packages.maxBytes`, with the bodyLimit raised separately in Fastify); the web layer proxy has its own limit `CAPYBARA_WEB_MAX_PACKAGE_BYTES`, see `docs/config.md`.
- Every download from a URL a marketplace or an admin supplied (marketplace manifests, mirrors, archive and git sources, git marketplaces, direct git import) goes through `packages/kernel/src/net` (`safeFetch`: https, no redirects, public addresses only unless `marketplaces.allowPrivateHosts`, connection pinned to the checked address); never call `fetch` on such a URL directly. Refusals map to `marketplace.private_address` / `marketplace.redirect` (422), with the refused host in `details` when known.
- The CLI reuses the same providers (`capybara admin grant|revoke <login>`, `capybara extensions …`) through `openKernelCli`, so domain classes must not depend on request context.

### Audit and personal tokens

A write calls `audit(this.db.db, { actorAccountId, actorTokenId?, orgId?, action, target?, detail? })` inside its `@Transactional` method (`KernelDb.db` is the context's transaction). When the request comes from a personal token, record the token id in `actor_token_id`: the controller takes the value with `patTokenId(requireUser(p))` (returns undefined for a web session) and passes it down as the optional trailing argument `actorTokenId` of the service method. `detail` must not contain secrets such as tokens or passwords.

### Current credential behavior

- Change password (`PUT /me/password`, `@SessionOnly`): reserves rate limit quota before checking the old password (scope `acct`: 10 per account id, 50 per client IP, separate from the login quota; over the limit 429 `auth.rate_limited`); on success it revokes **all web sessions of that account except the current one** and **revokes all of its personal access tokens** (R24); the new password, the session `revoked_at` and the token revocation are in the same PG transaction (`AccountsService.changePassword`), and the Redis revocation markers are then written on a best-effort basis.
- Disabling an account (`PATCH /admin/accounts/:id`) and revoking all its sessions and personal tokens are done in the same PG transaction (`AccountsService.updateAccount`), and the Redis revocation markers are written best-effort after commit (auth is settled by PG `revoked_at`).
- In the setup wizard and invitation sign-up, the session row is written in the same transaction as the account / org / membership (`SessionService.create(accountId, meta)` joins the context's transaction), and the cookie is set only after commit; a new "create an account and log in" flow should do the same.
- List endpoints always return an envelope object (such as `{ tokens: [...] }`, `{ members: [...] }`), never a bare array; paginated lists add `next` (the next-page cursor, passed back as `after`, null when there is no more), such as `GET /admin/accounts`.

## Parameter validation: zod DTOs

```ts
const CreateSchema = z.object({ name: z.string().min(1).max(100) });
class WidgetCreateBody extends createZodDto(CreateSchema, "WidgetCreateBody") {}

@Post()
async create(@ZBody(WidgetCreateBody) body: z.infer<typeof CreateSchema>) {}
```

`createZodDto` (`src/infra/validation/create-zod-dto.ts`) turns a zod schema into a named DTO class; `@ZBody(Dto)` / `@ZQuery(Dto)` / `@ZParam(Dto)` pass the DTO to the global validation pipe (no decorator metadata, so a bare `@Body()` typed with a DTO is never validated and `kc-zod-pipe` rejects it) and feed the OpenAPI document (`http.swagger`, served at `/docs`). A failure returns 400 `validation_failed` with `details` as the list of field problems. Route parameters that need validation go through a `@ZParam` DTO too (decision R20), so `details[].path` names the parameter. Give every string an upper bound (`max`) to prevent oversized input.

## Error codes

- Business errors throw `new ApiError(code, message)` (`src/errors.ts`); register a new code in `ERROR_CODES` first (code -> HTTP status), named `<domain>.<snake>`.
- `message` is **always English**; the UI uses `code` as the i18n key. Do not put secrets, password hashes or internal exception text into `message` / `details`.
- The response envelope is uniformly `{ error: { code, message, details? } }`, produced by `http/error.filter.ts`; framework errors (Nest `HttpException`, Fastify's body too large / unsupported media type and so on) are mapped to generic codes by the status table in that file: 400 `validation_failed`, 401 `auth.required`, 403 `forbidden`, 404 `not_found`, 409 `conflict`, 413 `payload_too_large`, 415 `unsupported_media_type`, 429 `rate_limited`, anything outside the table `internal`; unknown exceptions are always 500 `internal`, not echoed.
- 5xx is logged, with the path redacted by `redactPath` (an invitation token segment becomes `:token`, any segment starting with `cap_` becomes `:redacted`); do not put the raw URL or a token into log fields separately.

## Multiple replicas: where state lives

Production runs multiple replicas, and consecutive requests from the same user land on different processes.

| State | Where |
|---|---|
| Persistent data such as accounts, sessions, member roles, invitations | PG (`KernelDb`), read live on every request, **not cached in process memory** |
| Rate limit counters, short-lived markers | Redis (`REDIS`, throttlers, `LockService.lease` for markers); throttler keys start with `throttler:`, cache keys with `cache:`, `LockService.acquire` / `run` / `@WithLock` locks with `lock:`, cron tick markers with `cron:`; leases and markers taken with `lease` / `hold` keep their own keys (`capk:…`); **must have a TTL**; "check then write" must be atomic (Lua or `SET NX` through `LockService`) |
| Mutual exclusion inside a transaction | PG row locks, or a `*Lock` provider over `XactLock` (e.g. `SetupLock` for the setup wizard) |
| Mutual exclusion across a longer operation | `LockService` / `@WithLock` (Redis, renewed, lost at the deadline of decision R19) |
| Config | `KernelConfigService.get()` on every call, so hot updates take effect |
| Same-process notifications | `KernelEvents` only when the event may be lost and something re-derives it (a sweep, the next append); cross-replica ones go over the kernel bus |

Do not use in-process Maps, timers or local events to hold cross-request state. The dual-replica acceptance test (`packages/testing/test/m1-acceptance.test.ts`) exposes this kind of defect.

## Tests

Kernel tests start the real application with the helpers in `packages/kernel/test/helpers/runs.ts`: `startKernel(config, opts)` returns a `TestKernel` `{ app, http, port, close() }` (`port` is undefined after `close()`), `buildKernel` one that is built but not started (`start()` runs the production start). Reach a service with `k.app.get(Class)` (tokens: `k.app.get(REDIS)`; the logger is `k.app.get<KernelLogger>(KERNEL_ROOT_LOGGER)`, since the transient `KERNEL_LOGGER` cannot be resolved with `get`); `k.http.inject()` is Fastify light-my-request (no port), with the cookie jar from `packages/kernel/test/helpers/http.ts`:

```ts
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
    }),
  );
}, 120_000);
afterAll(async () => {
  await k?.close();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

it("is rejected when not logged in and allowed after login", async () => {
  expect((await k.http.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
  await k.app.get(AccountsService).createLocal({ login: "u", displayName: "U", password: "pw-long-enough" });
  const req = asUser(k.http, cookieJar()); // sends the cookie and X-Capybara-Csrf: 1, collects set-cookie
  const login = await req({ method: "POST", url: "/api/v1/auth/login", payload: { login: "u", password: "pw-long-enough" } });
  expect(login.statusCode).toBe(200);
  expect((await req({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(200);
});
```

Key points:

- **Test seams (decision R22)**: `KernelAppOptions.overrides` is for the kernel's own tests only. It takes values for the named seam tokens of `KernelOverride` (`src/overrides.ts`: `AGENT_LOOP_FACTORY`, `RUN_HOOKS`, `EVAL_REPLAY_HOOKS`, `TOOL_PIPELINE_HOOKS`, shorter timings such as `BOOTSTRAP_LOCK_TTL`, `EMBED_TOKEN_CLOCK`, `APP_INTERCEPTOR`) and refuses any other token when the application is built, so no domain class can be replaced. A new seam is an optional provider (`@Optional() @Inject(TOKEN)`, production default when absent) added to `KernelSeams` and its token tuple (a compile-time check ties the two); never a mutable public field. The tokens are not exported from the package, and `@capybara-hq/testing`'s `startTestKernel` takes no overrides: extension and plugin tests drive a real kernel through `startTestKernel` / `createDualReplicaHarness`.
- Unit tests that need a few providers without an application build them by hand through the test helpers (`test/helpers/database.ts` `databaseHandles(pool, log)`, `accountsFor`, …); tests are outside the `kc-wiring` scan, production code is not.
- When asserting errors, assert both the status code and `error.code`.
- Every new endpoint covers at least: not logged in, insufficient role / non-member (404), service token (if it has `@OrgAction`), validation failure, success path.
- For concurrency and cross-replica behavior (races, immediate invalidation on another replica after logout and so on) use `createDualReplicaHarness` from `@capybara-hq/testing` (the `config` option deep-merges kernel config, e.g. `{ auth: { cookieSecure: false } }`); see `packages/testing/test/m1-acceptance.test.ts`.
- A cron or processor test asserts on the worker role's application (`roles: ["worker"]`); `test/lifecycle/roles.test.ts` pins which providers each role builds.

## Platform operations: a route's twin for agents

The `Platform` builtin (spec `docs/superpowers/specs/2026-11-07-platform-tool-design.md`, §14 for
phase 2) lets an agent call the platform as the person who started the run. Every kernel HTTP route
is either mirrored by an operation or listed in `packages/kernel/src/platform/exclusions.ts` with a
reason; `pnpm check:platform-ops` fails otherwise (full run, part of `pnpm check`). So a new route in
a PR needs one of the two.

**Add, change, remove.**

- *Add a route:* export its zod schemas from `<domain>.schemas.ts` next to the controller (the
  controller uses them too), list the route in that file's `*_ROUTES` (registered in `ROUTE_SCHEMAS`
  of `platform/route-schemas.ts`), and add an operation whose input is built from those schemas
  (`pick` / `omit` / `extend`), or an exclusion with a reason.
- *Change a route's input:* change the shared schema; the operation follows. The parity test
  (`tools/checks/test/platform-parity.test.ts`, `inputParity` in `platform/parity.ts`) goes red when
  the operation's input and the route drift: a type differs, a bound is looser, a pattern / format is
  lost, a route-required field is optional, or a top-level route field is neither in the input nor in
  `omits`.
- *Remove a route:* its operation (or the `mirrors` entry) and its exclusion go in the same change;
  a mirror or exclusion naming no route is `platform-op-orphan`, a route both mirrored and excluded
  `platform-op-double`.

**Defining an operation.** Operations live in `platform/ops/<domain>.ops.ts`, in a provider that calls
`PlatformOperations.register(...)` from `onModuleInit` (listed in `PlatformOpsModule`; `PlatformModule`
imports no domain module). `defineOperation({...})` fields:

- `id`: `<domain>.<verb>`, kebab-case parts, the domain one of `PLATFORM_DOMAINS`; the policy key is
  `Platform:<id>`. `description`: English, the first sentence is what `browse` / `search` show.
- `input`: a strict zod schema from the route's shared schemas, every string bounded; `example`: a
  valid input (`describe` shows both). The parity bookkeeping, each entry checked for staleness:
  `omits` (top-level route fields the input leaves out, e.g. `uploadId`), `extras` (input fields
  the route lacks, e.g. `cursor`), `renames` (`{ skillId: "id" }`, a flattened
  `{ name: "definition.name" }`) and `loosens` (a field allowed to accept more than the route, with
  the reason; never the type).
- `authz`: `{ orgAction }` equal to the mirrored route's `@OrgAction`, or `{ superAdmin: true }`. When the
  service enforces a higher role than the decorator, name the stricter action and add
  `authzNote: "service-enforced"` (the check then requires a role at least the route's).
- `mirrors`: the routes it corresponds to (`"POST /api/v1/orgs/:orgId/skills"`), `[]` for a synthetic read.
- `confirm`: `read` runs without asking; `personal` asks and may be remembered; `org` and `platform`
  ask every time and are never remembered. `rememberable: false` makes a `personal` write asked every
  time too (destructive personal writes: `conversations.delete` / `abort` /
  `stop-background-task`, `agents.delete`, `agents.delete-skill`, `environments.delete` /
  `reset-files`). `confirmFor(input, ctx)` picks the class per call when it depends on the target
  (`agents.update`: `personal` only on the actor's own private agent; a throw counts as not
  remembered). A route marked `HUMAN_ONLY` is not an operation (exclusion `human-only`).
- `summary(input, ctx)`: for every write, the bilingual card line rendered from the validated input and
  kernel reads (target names, preview counts), never from model text (zh says 平台 / 超级管理员 / 智能体).
- `precheck(input, ctx)`: for a write, the read-only preconditions known to fail (a taken name, a stale
  preview hash, a missing deployment config, an invalid URL), returning `{ ok: true }` or
  `{ ok: false, code, message, next? }`; the tool runs it after availability and denies a failure with
  the message and the role's next step, so no card appears. Prefer a read-only `check…` method of the
  service that throws the write's own `ApiError`, wrapped in `precheckBy`. It runs again when an approved
  call resumes (a failure then returns the error and nothing runs); after 2 s or on a throw it is skipped
  and the write's own errors speak.
- `errors`: `{ code, next }[]` for the notable failures; `describe` shows them, and the tool appends an
  `ApiError`'s entry to its message. `next` says what to do next; where the step differs by role it is
  `{ superAdmin?, orgAdmin?, member? }` with an `orgAdmin` or `member` step (only the super admin gets
  the `superAdmin` text: the admin console path; an org admin falls back to `member`, a member to
  `orgAdmin`). A member's step never names the admin console or a config field. `platform-op-errors`
  requires `next` on every entry. Let a service `ApiError` propagate: the tool turns it into an
  actionable `ToolError` (`toToolError`), never a 500.
- `run(input, ctx)`: call the controller's service, never new logic, as `ctx.actorAccountId`; writes stay
  in the service's `@Transactional()` methods and pass `auditDetail: viaAgent("<id>", ctx)` so the audit
  event carries `{ via: "agent", operation, agentConversationId, agentRunId }` (distinct keys, so a
  write's own `conversationId` / `runId` survive the merge). Results hold no secrets, tokens,
  credential fields or secret config.

**Results.** A list returns compact rows: `id`, `name`, `state`, `reason?`, `next?` and at most 3
domain fields; details come from the domain's `get`. Lists page by 50 with `pageOf(rows,
startOf(cursor), 50)` (`params.cursor`, result `{ items, total, next }`). A route that pages by
keyset (the service takes `after`, so no total is known) keeps that: input `after` from the route's
schema, result `{ <items>, next }` where `next` is the last row's id (or the service's own `next`)
and the description says "pass the returned next as params.after" (`accounts.list`,
`conversations.list` / `subagents` / `files`, `evals.list-results`); never an offset over a keyset
route. Super admin operations run only through the super admin's own private agent and return the
admin console's data in full: platform items and the conversation org's own items are named (orgs
included: previews, scope lists, the orgs a component is on in). An item another org owns is only
counted (`otherOrg…` fields) and get / update on it is refused (`assertNotOtherOrgs` /
`assertExtensionNotOtherOrgs` in `platform/ops/other-orgs.ts`), also on a race past the precheck (a
service error naming that org's items is rethrown without them).

**Exclusions.** `PLATFORM_EXCLUSIONS` entries have a category and a reason: `human-only` (deciding
approvals and requests, confirming extension permissions, roles, the super-admin flag, sign-in and
setup), `secret` (tokens, credentials, secret config values, cross-org config state), `transport`
(uploads, downloads, streams, presigned URLs), `internal` (the web's own plumbing). A `@SessionOnly()`
route is `human-only` or `secret`, never mirrored (`platform-op-session-only`). A controller that
switches a mirrored route to a schema not in its `ROUTE_SCHEMAS` entry is caught only by review: the
parity test compares the registered schemas, and tying a `@ZBody` / `@ZQuery` DTO back to that entry
would need cross-file resolution the source scan does not do. There is no `later`:
`platform-op-later` fails any such exclusion. An operation that would touch a secret refuses with a
pointer to the web page.

**Adding a domain.** Add the id and its one-line description to `PLATFORM_DOMAINS`
(`platform/operation.ts`), the provider to `PlatformOpsModule`, its routes to `ROUTE_SCHEMAS`, and the
id to the domain list asserted in `test/tools/platform-tool.test.ts`; tests go in
`test/platform/ops-<domain>.test.ts` against PG with the real services.

**Docs topics.** What the agent reads with `Platform` `read` is `packages/plugin-sdk/agent-docs/` (served by
`AgentDocs`); a new extension point needs its topic there and `pnpm gen:agent-docs` renders the field tables
(`check:agent-docs`; hand-written tables are checked for orphans only).

**The fence.** Tests prove the actor is the run's trigger account, re-read on every call, and that params
cannot change between an approval and the run: `test/platform/*.test.ts`, and the end-to-end runs
`test/platform/platform-e2e.test.ts` and `platform-e2e-phase2.test.ts` (model-fake scripts the calls through
the real pipeline; the log replays with zero drift).

## Checklist

1. Service: an `@Injectable` provider with `@Inject` on every constructor parameter, in its domain module's `providers` (and `exports` when another module or a controller uses it); `@Transactional` methods for writes; unit tests.
2. Controller: listed in `CONTROLLERS` of `src/http/api.module.ts` (`ApiModule` imports the domain module), auth decorators, DTOs with `@ZBody` / `@ZQuery` / `@ZParam`; register new error codes in `errors.ts`.
3. A periodic job: `@LockedCron` / `@LockedInterval` in a job provider listed in `WorkerModule`; a queue consumer: a `@Processor` under `WorkerModule` running each job in `runJob`.
4. A new `@Public()` route -> update `public-routes.test.ts`.
5. New config items follow `.agents/skills/adding-config`; new tables follow `.agents/skills/writing-migrations`.
6. `pnpm lint && pnpm typecheck && pnpm check && pnpm test` (`check:kernel-conventions` is part of `pnpm check`); changes that affect publishing add a changeset.
