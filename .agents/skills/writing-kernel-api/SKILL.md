---
name: writing-kernel-api
description: 'Use when adding or changing a kernel HTTP API (Nest controller, guard, error code): domain classes do not depend on Nest and are injected with useFactory, constructor parameters use explicit @Inject, default deny and the @Public list, @OrgAction and HUMAN_ONLY, ZodPipe, registering error codes, where state lives under multiple replicas, and a template for writing tests with http.inject().'
---

# Writing the kernel HTTP API

The kernel HTTP layer is **NestJS + Fastify** (`packages/kernel/src/http/`). Only the kernel uses Nest: **extensions do not depend on Nest**, and extension routes are still `ctx.http.route(method, path, (req: Request) => Promise<Response>)` (see `.agents/skills/writing-extensions`).

Reference implementation: `packages/kernel/src/orgs/` (`orgs.controller.ts` + `members.service.ts` + `org.guard.ts`).

## Layering: domain classes do not depend on Nest

| Layer | Where it lives | Rule |
|---|---|---|
| Domain service | `src/<domain>/*.service.ts` or a similar file | A plain class with **no Nest decorators and no `@nestjs/*` imports**; dependencies (`KernelDb`, `Redis`, other services) come through constructor parameters |
| Injection token | `src/http/tokens.ts` | One `Symbol` per service, with a one-line JSDoc stating the corresponding type |
| Wiring | `serviceProviders()` in `src/http/api.module.ts` | `{ provide: TOKEN, useFactory: (db: KernelDb) => new XxxService(db), inject: [KERNEL_DB] }` |
| Controller | `src/<domain>/*.controller.ts`, added to `CONTROLLERS` | Only parses parameters, declares auth, calls services and sets cookies; business rules live in the service |

Domain classes that don't depend on Nest can be unit-tested with a direct `new XxxService(db)`, and the CLI (such as `capybara admin create`) can reuse them.

## Constructor parameters must use an explicit `@Inject`

```ts
@Controller("api/v1/widgets")
export class WidgetsController {
  constructor(
    @Inject(WIDGETS) private readonly widgets: WidgetsService,
    @Inject(KERNEL_CONFIG) private readonly config: () => KernelConfig,
  ) {}
}
```

Reason: the repo enables `experimentalDecorators` but **not `emitDecoratorMetadata`**; tsx / esbuild and Vitest also do not emit design-time type metadata. Nest cannot get the parameter types, and a missing `@Inject` reports "Nest can't resolve dependencies" at app initialization. The same goes for guards (`@Inject(Reflector)`, `@Inject(KERNEL_DB)`). An entry point that runs the kernel with tsx must load the repo's `tsconfig.base.json` (root scripts use `--tsconfig tsconfig.base.json`), otherwise the decorators cannot compile.

## Auth: default deny

The global `AuthGuard` (`APP_GUARD`) requires credentials by default on **every** route (a Bearer API token, or the session cookie `cap_at`; whether a session is revoked is checked first by the Redis marker and then settled by PG `sessions.revoked_at`, so Redis data loss does not resurrect a revoked session); non-safe methods (POST / PUT / PATCH / DELETE) authenticated by cookie require the CSRF header `X-Capybara-Csrf: 1`, and Bearer is not checked. Account status is read live on every request, and a disabled account gets 403 `auth.account_disabled`. Stack decorators as needed:

| Decorator | Meaning |
|---|---|
| `@Public()` | Credentials not required (credentials, if present, are still parsed into a principal; when credentials are invalid, i.e. an `ApiError`, they are treated as absent, while other exceptions such as PG / Redis failures are still 500). Non-safe methods on public routes require `X-Capybara-Csrf: 1` whether or not a cookie is present |
| `@SessionOnly()` | Accepts only web sessions, such as token management and password change: a personal token -> 403 `auth.session_required`, a service token -> 403 `forbidden` |
| `@EnterpriseAdmin()` | Allows only enterprise admins; service tokens are always 403 |
| `@AllowService()` | Allows service tokens (a service principal is rejected by default) |
| `@OrgAction(action)` | Org-level route, see below |
| `@CurrentPrincipal()` | Parameter decorator, gets the principal; call `requireUser(p)` when a human user is needed |

**Adding a `@Public()` route must also update the `PUBLIC_ROUTES` list in `packages/kernel/test/identity/public-routes.test.ts`**, otherwise the meta test fails. This test enumerates all routes and requests each without credentials, ensuring no route is accidentally public; it also mounts a probe `APP_INTERCEPTOR`, and any route outside the list fails as soon as its handler is executed (the guard did not reject), so throwing `auth.required` yourself inside the handler cannot hide a mistaken `@Public()`. A public route must be a genuinely no-login entry point (login, refresh, invitation, setup), and rate limiting and enumeration attacks must be considered.

### Credential attempt rate limiting (`RATE_LIMITER`)

`LoginRateLimiter` (`src/identity/rate-limit.ts`), counted in Redis with a 900s window; it atomically reserves one unit of quota **before** verifying credentials and refunds it on success:

- Login `reserve(login, ip)` / `succeeded(login, ip)`: (login, IP) 10 attempts, IP 50, a single login across IPs 100; reaching any limit gives 429 `auth.rate_limited` (with `Retry-After`), and a rejected attempt **increments no counter** (Lua checks before incrementing). An attacker exhausting a login name from their own IP does not affect the real user logging in from another IP.
- Other endpoints that check credentials use `reserveScoped(scope, key, ip, limit, ipLimit = 50)` / `succeededScoped(scope, key, ip)`, with keys `capk:rl:<scope>:…`, kept separate from the login IP quota. Existing scopes: `acct` (change password, 10 per account id), `setup` (setup token, 100 for the whole deployment, 10 per IP), `inv` (accept invitation, 10 per token, 20 per IP). A new public entry point that checks credentials / tokens should hook in the same way.

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
- **A role-dependent write must re-read the role inside the transaction**: the role may change between the guard's decision and the write. In the service transaction call `lockOrgAndAuthorize(trx, orgId, actorAccountId, action)` (`src/orgs/org-lock.ts`): `SELECT … FROM capybara.orgs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE` locks the org row, then reads the initiator's current role; org nonexistent / deleted -> 404 `org.not_found`, non-member or insufficient role -> 403 `forbidden`, and it returns `{ org, role }` for further checks (such as a token / invitation role not exceeding the initiator's). When you only need serialization and not the role, use `lockOrg` / `tryLockOrg`. Services accept only the initiator's account id, never a role passed in by the caller.
- **Enterprise admin writes are the same** (`@EnterpriseAdmin` is only a check at the start of the request): revoking / disabling an account, creating an account (including an enterprise admin) and changing deployment settings all first call `lockEnterpriseAdminsAndAuthorize(trx, actorAccountId)` (`src/identity/enterprise-admin.ts`) inside the transaction: it takes `pg_advisory_xact_lock(hashtext('capybara.enterprise_admins'))` to serialize and, inside the lock, confirms the initiator is still an active enterprise admin, otherwise 403 `forbidden`. A new enterprise admin write must do the same.
- **An admin demoting themselves is allowed**: `PATCH /orgs/:orgId/members/:self` (admin -> member / guest) succeeds as usual and writes an `org.member.role_changed` audit entry; only granting / revoking / changing an owner requires the initiator to be an owner, and no operation may leave an org without an owner (`org.last_owner`). After the demotion the account immediately loses `org.members.manage`, and later requests are decided live by OrgGuard.
- **A write that depends on "the membership still exists" locks the membership row first**: for example `PUT /me/current-org` in one transaction first takes `FOR SHARE` on the org row, then `SELECT … FROM memberships WHERE org_id = $1 AND account_id = $2 FOR SHARE` (querying only that one row), then writes the session; the lock order must match "remove member" (org row -> membership row), otherwise it deadlocks.
- **Token expiry** uses the shared schema `FutureIsoDate` exported from `identity/api-tokens.ts` (a full ISO 8601 datetime string later than now; a number, `"2099-01-01"` and the like -> 400).
- **Org extension config** (`OrgExtensionConfigs`): `get` / `list` read config rows and secrets in a `REPEATABLE READ` read-only transaction; for an extension with `enabled=false`, `get` does not validate and returns `{ enabled: false, config: null }`; `put` clears, in the same transaction, the `capybara.secrets` rows for secret paths that no longer exist in the current schema; when never configured the `config` column stores NULL.

### Existing org actions (since M6)

`connectors.manage` (admin) / `connectors.use` (guest) are the connector actions after the D17 rename (formerly `apps.*`; HTTP `/api/v1/orgs/:orgId/connectors*`, error codes `connector.*`; no `/apps` alias and no compatibility layer, C28). M6 added:

| Action | Minimum role | Used for |
|---|---|---|
| `trajectories.read` | member | trajectory viewer; the service then decides "org admin or the agent's owner", eval conversations go only to org admins, and everything else is 404 |
| `evals.manage` | admin | eval sets, cases, runs, annotations |
| `org.models.manage` | admin | this org's model purpose mapping (`/model-purposes`) |
| `catalog.read` | member | the org's view of the catalog; the `POST catalog/:itemId/install` route needs only this one, and the service re-checks `skills.manage` / `connectors.manage` / `org.extensions.manage` by kind inside the org row lock (a plugin needs all three) |
| `catalog.request` | member | a member requests a catalog item |
| `catalog.decide` | admin | an org admin decides a member's request |

All of the above are in `HUMAN_ONLY` (403 for service tokens). Register new actions in `roles.ts` the same way and add a one-line comment stating the purpose.

Old audit records `app.*` are not rewritten; when querying audit by action use the explicit mapping in `auditActionAliases` (`identity/audit.ts`) to treat the old and new names as synonyms (do not guess by prefix). The 2026-10-24 terminology rename (`plugin.*` -> `extension.*`, `directory.*` -> `catalog.*`, `catalog.*` -> `marketplace.*`, bundle `app.*` -> `plugin.*`) has no aliases: rows written before it keep their old names.

### Enterprise admin endpoints (`/api/v1/admin/*`)

Deployment-level endpoints always go under `/api/v1/admin/*`, with `@EnterpriseAdmin()` on the controller (service tokens always 403), and are always called "enterprise admin" (the code identifier `@EnterpriseAdmin` and the path `/admin` are not renamed, C1). A write first calls `lockEnterpriseAdminsAndAuthorize` in its transaction (see above). Existing ones:

| Path | Controller | Content |
|---|---|---|
| `overview`, `accounts*`, `orgs`, `settings`, `models`, `model-prices`, `model-purposes*` | `admin/admin.controller.ts` | overview, accounts, orgs, deployment settings (`deployment_settings`: `orgCreation`, `runConcurrencyOverrides`, `sandboxLimitOverrides`, `priceCurrency`, `customConnectors`, `customSkills`), models, prices, the deployment default purpose mapping |
| `extensions*` | `admin/extensions.controller.ts` | extension list and details, deployment-level config (`:name/config`), approval, install / enable / disable / uninstall, package upload (`packages/file`) and npm import (`packages/npm`) |
| `catalog*` | `catalog/admin-catalog.controller.ts` | catalog import (`import/file`, `import/npm`), plugins `plugins/prepare/*` -> `plugins/:stagingId/confirm`, item list / details / icon / policy / delete, installing extension items to the deployment (`items/:id/install-deployment`) |
| `catalog/requests*` | `catalog/org-catalog.controller.ts` | catalog requests awaiting an enterprise admin's decision |
| `marketplaces*` | `catalog/marketplaces.controller.ts` | create / update / delete official / enterprise marketplaces, refresh, browse entries (`entries`), import from a marketplace |

- Enterprise admins **cannot read conversations** by default: trajectories and evals go only to org admins and agent owners (C1); do not add endpoints under `/admin` that read conversation content.
- The package upload route takes raw bytes (`application/octet-stream`, limit `packages.maxBytes`, with the bodyLimit raised separately in Fastify); the web layer proxy has its own limit `CAPYBARA_WEB_MAX_PACKAGE_BYTES`, see `docs/config.md`.
- The CLI reuses the same domain classes (`capybara admin grant|revoke <login>`, `capybara extensions …`), so domain classes must not depend on request context.

### Audit and personal tokens

A write calls `audit(trx, { actorAccountId, actorTokenId?, orgId?, action, target?, detail? })` in the same transaction. When the request comes from a personal token, record the token id in `actor_token_id`: the controller takes the value with `patTokenId(requireUser(p))` (returns undefined for a web session) and passes it down as the optional trailing argument `actorTokenId` of the service method. `detail` must not contain secrets such as tokens or passwords.

### Current credential behavior

- Change password (`PUT /me/password`, `@SessionOnly`): reserves rate limit quota before checking the old password (scope `acct`: 10 per account id, 50 per client IP, separate from the login quota; over the limit 429 `auth.rate_limited`); on success it revokes **all web sessions of that account except the current one** and **revokes all of its personal access tokens** (R24); the new password, the session `revoked_at` and the token revocation are in the same PG transaction (`AccountsService.changePassword`), and the Redis revocation markers are then written on a best-effort basis.
- Disabling an account (`PATCH /admin/accounts/:id`) and revoking all its sessions and personal tokens are done in the same PG transaction (`AccountsService.updateAccount`), and the Redis revocation markers are written best-effort after commit (auth is settled by PG `revoked_at`).
- In the setup wizard and invitation sign-up, the session row is written in the same transaction as the account / org / membership (`SessionService.create(accountId, meta, trx)`), and the cookie is set only after commit; a new "create an account and log in" flow should do the same.
- List endpoints always return an envelope object (such as `{ tokens: [...] }`, `{ members: [...] }`), never a bare array; paginated lists add `next` (the next-page cursor, passed back as `after`, null when there is no more), such as `GET /admin/accounts`.

## Parameter validation: `ZodPipe`

```ts
const Body = z.object({ name: z.string().min(1).max(100) });

@Post()
async create(@Body(new ZodPipe(Body)) body: z.infer<typeof Body>) {}
```

A validation failure returns 400 `validation_failed` with `details` as the list of field problems. Give every string an upper bound (`max`) to prevent oversized input.

## Error codes

- Business errors throw `new ApiError(code, message)` (`src/errors.ts`); register a new code in `ERROR_CODES` first (code -> HTTP status), named `<domain>.<snake>`.
- `message` is **always English**; the UI uses `code` as the i18n key. Do not put secrets, password hashes or internal exception text into `message` / `details`.
- The response envelope is uniformly `{ error: { code, message, details? } }`, produced by `http/error.filter.ts`; framework errors (Nest `HttpException`, Fastify's body too large / unsupported media type and so on) are mapped to generic codes by the status table in that file: 400 `validation_failed`, 401 `auth.required`, 403 `forbidden`, 404 `not_found`, 409 `conflict`, 413 `payload_too_large`, 415 `unsupported_media_type`, 429 `rate_limited`, anything outside the table `internal`; unknown exceptions are always 500 `internal`, not echoed.
- 5xx is logged, with the path redacted by `redactPath` (an invitation token segment becomes `:token`, any segment starting with `cap_` becomes `:redacted`); do not put the raw URL or a token into log fields separately.

## Multiple replicas: where state lives

Production runs multiple replicas, and consecutive requests from the same user land on different processes.

| State | Where |
|---|---|
| Persistent data such as accounts, sessions, member roles, invitations | PG (`KERNEL_DB`), read live on every request, **not cached in process memory** |
| Rate limit counters, short-lived markers | Redis (`KERNEL_REDIS`), key prefix `capk:`, **must have a TTL**; "check then write" must be done atomically with Lua |
| Concurrency mutual exclusion | PG row locks / advisory locks (e.g. the setup wizard uses `pg_advisory_xact_lock`) |
| Config | Inject `KERNEL_CONFIG` (`() => KernelConfig`) and take the current value on every call, so hot updates take effect |

Do not use in-process Maps, timers or local events to hold cross-request state. The dual-replica acceptance test (`packages/testing/test/m1-acceptance.test.ts`) exposes this kind of defect.

## Test template

Single-replica HTTP tests use `kernel.http.inject()` (Fastify light-my-request, takes no port) plus the cookie jar from `packages/kernel/test/helpers/http.ts`:

```ts
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { asUser, cookieJar } from "../helpers/http.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
}, 120_000);
afterAll(async () => {
  await k?.stop();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

it("is rejected when not logged in and allowed after login", async () => {
  expect((await k.http.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
  // after preparing an account (e.g. new AccountsService(kernelDb(db)).createLocal(...)):
  const req = asUser(k.http, cookieJar()); // automatically sends the cookie and X-Capybara-Csrf: 1, and collects set-cookie
  const login = await req({ method: "POST", url: "/api/v1/auth/login", payload: { login: "u", password: "pw" } });
  expect(login.statusCode).toBe(200);
  expect((await req({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(200);
});
```

Key points:

- When asserting errors, assert both the status code and `error.code`.
- Every new endpoint covers at least: not logged in, insufficient role / non-member (404), service token (if it has `@OrgAction`), validation failure, success path.
- For concurrency and cross-replica behavior (races, immediate invalidation on another replica after logout and so on) use `createDualReplicaHarness` from `@capybara-hq/testing` (the `config` option deep-merges kernel config, e.g. `{ auth: { cookieSecure: false } }`); see `packages/testing/test/m1-acceptance.test.ts`.

## Checklist

1. Domain service (no Nest) + unit tests.
2. Add a token in `tokens.ts`, and a `useFactory` provider and the controller in `api.module.ts`.
3. Controller: constructor parameters with `@Inject`, auth decorators, `ZodPipe`; register new error codes in `errors.ts`.
4. A new `@Public()` route -> update `public-routes.test.ts`.
5. New config items follow `.agents/skills/adding-config`; new tables follow `.agents/skills/writing-migrations`.
6. `pnpm lint && pnpm typecheck && pnpm check && pnpm test`; changes that affect publishing add a changeset.
