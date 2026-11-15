# Extension route access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every `permissions.http` route declares `access` (`public` / `embed` / `member` / `admin`); the kernel enforces it before the body is read and hands the handler the caller.

**Architecture:** the SDK owns the manifest type, its validation and `RouteCaller`. `create-ctx` turns each `ctx.http.route` into a `Route` record that carries its access, its mounted path (`/plugins/<name>/orgs/:orgId<path>` for member/admin) and the extension's embed verifier. The plugin dispatch's scope gets an `onRequest` hook: 503 gate → match (with params) → `PluginRouteAccess.resolve()` (auth, authorization, effective config, throttle) → the result is stored on the request; the handler stage calls `handler(webReq, caller)` after stripping kernel credentials.

**Tech Stack:** TypeScript, Fastify + find-my-way, Kysely, Redis throttler storage, vitest.

**Spec:** `docs/superpowers/specs/2026-11-15-extension-route-auth-design.md`

## Global Constraints

- Access values exactly `"public" | "embed" | "member" | "admin"`; `public?: boolean` is removed, no compatibility reading (pre-0.1.0).
- Member/admin mount: `/plugins/<name>/orgs/:orgId<path>`; public/embed mount: `/plugins/<name><path>`.
- Member/admin credentials: `Authorization: Bearer cap_pat_…` only; cookies are ignored (treated as no credential); service tokens → 403 `forbidden`.
- Error codes (existing only): `auth.required` 401, `auth.password_change_required`, `auth.account_disabled`, `forbidden` 403, `org.not_found` 404, `extension.needs_config` 409, `rate_limited` 429, `extension.unavailable` 503.
- Public-write throttle: POST/PUT/DELETE on `public` routes, 300 per 60 s per client IP per extension, Redis-backed.
- Snapshot key: `permissions.http.<access>:<METHOD> <path>`; `public` and `embed` are sensitive.
- English comments; comments and test titles you edit get translated to English (no bulk translation).
- Tests: no fixed sleeps, no per-test timeouts; a new unit/container test file joins its checked-in list; integration is the default project.
- Commits: Conventional Commits, body lines ≤ 100 chars, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`.

## Review Focus

1. A request whose path is `/plugins/<name>/orgs/<org>/x` where the extension also has a public route `/orgs/...`: impossible by validation, but a revoked-then-reloaded extension must not leave a stale route — the router is rebuilt per table revision (Task 3 test "routes follow the table revision").
2. A member/admin request carrying both a session cookie and no Authorization header: must be 401 `auth.required`, never authenticated by the cookie (Task 3 test).
3. HEAD on a member route: uses the GET record's access and its params (Task 3 test).
4. An embed token passed as `?token=` on a POST with a large body: refused before the body is read (Task 3 test with a body over 1 MiB that still gets 401, not 413).
5. A handler that echoes `req.headers.get("authorization")` on a member route returns empty, while on an embed route it returns the embed token (Task 3 test).

---

### Task 1: SDK and plugin-tools contract

**Files:**
- Modify: `packages/plugin-sdk/src/permissions.ts` (type at :10-11, validator at ~:164-187)
- Modify: `packages/plugin-sdk/src/ctx.ts:152-159` (handler signature)
- Create: `packages/plugin-sdk/src/http-access.ts` (`HttpAccess`, `HTTP_ACCESS`, `RouteCaller`), exported from the package index
- Modify: the JSON Schema entry for `permissions.http` (find it with `git grep -n '"http"' packages/plugin-sdk/schema*` or the schema generator; it must list `access` as required with the enum)
- Modify: `packages/plugin-sdk/src/ui.ts` (embed contribution path must be a public GET; see rule below)
- Modify: `packages/plugin-tools/src/check/plugin-permissions.ts` and fixtures `packages/plugin-tools/fixtures/plugin-perm-*/src` (add `access`)
- Test: `packages/plugin-sdk/test/permissions.test.ts` (or the existing test file covering `validatePermissions`), `packages/plugin-sdk/test/ui.test.ts`, `packages/plugin-tools/test/plugin-permissions.test.ts`
- Run `pnpm gen:sdk-api`; add a changeset (`@capybara-hq/plugin-sdk` minor note "breaking for route authors" is a patch-level prerelease bump like the others in `.changeset/`; `@capybara-hq/plugin-tools` patch)

**Interfaces:**
- Produces:
  ```ts
  export const HTTP_ACCESS = ["public", "embed", "member", "admin"] as const;
  export type HttpAccess = (typeof HTTP_ACCESS)[number];
  export interface HttpPermission { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; access: HttpAccess }
  export type RouteCaller =
    | { access: "public" }
    | { access: "embed"; scope: "org"; orgId: string; accountId: string; role: OrgRole;
        contribution: string; conversationId?: string; config: unknown }
    | { access: "embed"; scope: "platform"; accountId: string; role: "superAdmin"; contribution: string }
    | { access: "member" | "admin"; orgId: string; accountId: string; role: OrgRole; config: unknown };
  // ctx.http.route(method, path, handler: (req: Request, caller: RouteCaller) => Promise<Response>)
  ```
  `OrgRole` is the SDK's existing org role type (reuse it; do not redefine).

- [ ] **Step 1: failing validator tests** — in the permissions test add cases, each asserting the exact error string is present in `validatePermissions("p", { http: [...] })`:
  - missing access → `permissions.http entries need method GET/POST/PUT/DELETE, a path starting with /, and access public/embed/member/admin`
  - `access: "org-admin"` → same message
  - `{ method:"GET", path:"/data", access:"embed" }` → `permissions.http embed route "GET /data" must be under /ui/`
  - `{ method:"GET", path:"/orgs/:orgId/x", access:"member" }` → `permissions.http route "GET /orgs/:orgId/x" must not contain :orgId (the org comes from the mount)` — the rule is: member/admin path contains the segment `:orgId`
  - `{ method:"POST", path:"/orgs/hook", access:"public" }` → `permissions.http route "POST /orgs/hook" must not start with /orgs/ (reserved for org routes)` (also for embed; `/orgs` exactly counts too)
  - `public: true` alone (old form) → the missing-access message
  - duplicates are keyed by `METHOD path` regardless of access (two entries differing only by access → duplicate error)
  - valid set of all four levels → `[]`
- [ ] **Step 2: failing ui test** — an embed contribution whose `path` is `/ui/board` with `http` lacking `{GET,/ui/board,public}` returns an error containing `embed path "/ui/board" must be declared in permissions.http as GET with access public`; with the entry declared it passes. Locate the existing embed-path check in `ui.ts` and extend it.
- [ ] **Step 3: run** `pnpm exec vitest run packages/plugin-sdk` → the new cases FAIL.
- [ ] **Step 4: implement** the types, validator rules, ui rule, ctx signature, JSON schema; update `perm-http` in plugin-tools so its static scan and messages use `access` (its fixtures get `access`); add a plugin-tools test asserting a manifest without access fails `check`.
- [ ] **Step 5: run** `pnpm exec vitest run packages/plugin-sdk packages/plugin-tools` → PASS; `pnpm gen:sdk-api`; `pnpm check:sdk-api check:sdk-api-changeset` (or `pnpm check`) → PASS. Kernel typecheck will now fail until Task 2; that is expected — do not touch kernel files.
- [ ] **Step 6: commit** `feat(plugin-sdk)!: extension routes declare access`.

### Task 2: kernel route records, approval keys, fixtures

**Files:**
- Modify: `packages/kernel/src/ctx/create-ctx.ts` (`Route` type :98, `declaredRoutes` :443, `http.route` :597-619, `verifyEmbedToken` :781-797)
- Modify: `packages/kernel/src/extensions/permission-set.ts:182-184, 231-233` (snapshot keys), `packages/kernel/src/extensions/permission-view.ts:117-119` (review display: show access; `public` and `embed` sensitive)
- Modify every fixture and test that registers a route or declares `permissions.http` (44 files from `git grep -l "http\.route\|http: \[" -- packages plugins apps tools`), including `packages/testing/fixtures/extensions/*`, `packages/testing/test/fixtures/*`, `packages/kernel/test/**`. Probes and counters → `public`; fake-embed data routes → `embed` and read `caller` instead of calling `ctx.ui.verifyEmbedToken`; fake-embed page paths → `public` GET; the `embed-consumer` probe → `member`, using `caller.orgId` instead of the body's `orgId`.
- Test: `packages/kernel/test/extensions/permission-set*.test.ts` (existing), a new unit test `packages/kernel/test/ctx/route-records.test.ts` if create-ctx route behaviour has no unit home (add to the kernel-unit list).

**Interfaces:**
- Consumes: Task 1 `HttpAccess`, `RouteCaller`, handler signature.
- Produces:
  ```ts
  export type Route = {
    plugin: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;            // full mounted path, e.g. /plugins/p/orgs/:orgId/items
    access: HttpAccess;
    handler: (req: Request, caller: RouteCaller) => Promise<Response>;
    verifyEmbed: (token: string) => Promise<EmbedClaimsWithRole | null>; // same function as ctx.ui.verifyEmbedToken
  };
  ```
  `EmbedClaimsWithRole` is whatever `ctx.ui.verifyEmbedToken` returns today (claims plus live `role` for org scope); name the type and export it.

- [ ] **Step 1: failing tests** — (a) route record: an extension declaring `{GET,/items,member}` and registering it yields a Route with `path === "/plugins/p/orgs/:orgId/items"`, `access === "member"`; `{POST,/hook,public}` yields `/plugins/p/hook`; registering `GET /items` when the manifest declares it only as POST still throws the permission error. (b) snapshot: `permissions.http.member:GET /items` is the key; changing access public→embed produces a different key set (re-approval).
- [ ] **Step 2: run** them → FAIL.
- [ ] **Step 3: implement** in create-ctx: `declaredRoutes` becomes a `Map<"METHOD path", HttpAccess>`; mount path by access; duplicate detection on the full path; attach `plugin` and `verifyEmbed` (extract the body of `verifyEmbedToken` into a local function used by both). Snapshot keys and review display per the Global Constraints. Then migrate the fixtures/tests.
- [ ] **Step 4: run** `pnpm typecheck` → PASS except `plugin-dispatch.ts` calling `handler(webReq)` with one argument: pass `{ access: "public" }` there **temporarily** (Task 3 replaces it). Run `pnpm exec vitest run packages/kernel/test/extensions packages/plugin-tools packages/testing` → PASS (embed/member fixture tests that need Task 3 behaviour may fail; list them in the report, do not weaken them).
- [ ] **Step 5: commit** `feat(kernel): route records carry access and their mount path`.

### Task 3: enforce access in the plugin dispatch (trust boundary — most capable model, reviewed alone)

**Files:**
- Modify: `packages/kernel/src/http/plugin-dispatch.ts`
- Create: `packages/kernel/src/http/plugin-route-access.ts`
- Modify: `packages/kernel/src/http/app.ts:251-274` (construct and pass the resolver)
- Modify: `packages/kernel/src/identity/auth.guard.ts` (export a PAT-only resolver; no behaviour change for the guard)
- Modify: `packages/kernel/src/infra/throttler/named-throttlers.ts` (add `pluginPublicWrite`, 300 / 60 000 ms) if named throttlers are the registry for Redis keys
- Test: `packages/kernel/test/http/plugin-route-access.test.ts` (integration, one app per file, using a fixture extension with one route per access level — extend `fake-embed` or add `packages/testing/fixtures/extensions/fake-routes`), unit tests for pure helpers in `packages/kernel/test/http/plugin-dispatch.test.ts` (existing).

**Interfaces:**
- Consumes: Task 2 `Route` (with `access`, `plugin`, `verifyEmbed`); `EffectiveConfigs.get(orgId, plugin): Promise<EffectiveConfig>` (`extensions/effective-config.ts:208`); `RedisThrottlerStorage.reserve(keys, limits, ttlMs)`; `queryEnabledPlugins` / the `currentEmbedRole` query shape (`create-ctx.ts:143`); `AuthServices`.
- Produces:
  ```ts
  // plugin-dispatch.ts
  export interface PluginRouter {
    find(method: string, path: string): { route: Route; params: Record<string, string> } | undefined;
  }
  export interface RouteAccessResolver {
    /** Throws ApiError on refusal. Never reads the body. */
    resolve(route: Route, req: FastifyRequest, params: Record<string, string>): Promise<RouteCaller>;
  }
  registerPluginDispatch(fastify, getTable, log, access: RouteAccessResolver)
  export function stripKernelAuthorization(value: string): string | undefined; // drops Bearer cap_pat_/cap_svc_
  // plugin-route-access.ts
  export class PluginRouteAccess implements RouteAccessResolver { constructor(deps: {...}) }
  export async function orgRouteMember(db, plugin, orgId, accountId): Promise<OrgRole | undefined>;
  ```

Resolution rules for `PluginRouteAccess.resolve` (each line is a test in Step 1):
- `public`: unsafe method → reserve `throttlerKey("pluginPublicWrite", `${plugin}:${req.ip}`)`, over the limit → 429 `rate_limited` with `retry-after`; return `{ access: "public" }`.
- `embed`: token from `Authorization: Bearer <t>` (not a `cap_` token) or `?token=`; none → 401 `auth.required`; `route.verifyEmbed(t)` null → 401 `auth.required`; org scope → effective config, `ok: false` → 409 `extension.needs_config`; return the caller per the Task 1 union (platform scope has no config).
- `member` / `admin`: Bearer `cap_pat_` only (cookie ignored); missing/invalid → 401 `auth.required`; service token → 403 `forbidden`; disabled → `auth.account_disabled`; must change password → `auth.password_change_required`; `orgRouteMember` undefined (not a member, org deleted, extension off) → 404 `org.not_found`; role rank below `member` (guest) or below `admin` → 403 `forbidden`; effective config not ok → 409 `extension.needs_config`; return the caller.

- [ ] **Step 1: failing integration tests** (one app, the fixture extension with routes `GET /ping` public, `POST /hook` public, `GET /ui/data` embed, `GET /items` member, `POST /items` member, `GET /settings` admin; each handler returns `JSON.stringify({caller, auth: req.headers.get("authorization"), cookie: req.headers.get("cookie")})`):
  - public GET → 200, `caller = {access:"public"}`
  - member GET with an owner's PAT → 200, caller has `orgId`, `accountId`, `role:"owner"`, `config`; `auth` is null
  - member GET with cookie only (logged-in session) → 401 `auth.required`
  - member GET with a service token → 403 `forbidden`
  - member GET by a non-member's PAT → 404 `org.not_found`; same for an org where the extension is disabled
  - member GET by a guest → 403 `forbidden`; admin GET by a member → 403; by an admin → 200
  - member POST with a 2 MiB body and no token → 401 (not 413): auth runs before the body
  - HEAD `/items` → 200 with the GET route's checks (no token → 401)
  - embed GET with a valid org token (Bearer and `?token=`) → 200, caller has `contribution`, `role`; `auth` equals the embed token; with no token → 401; with a token whose account left the org → 401
  - extension needs config in the org → 409 `extension.needs_config`
  - public POST 301 times from one IP → the 301st is 429 `rate_limited` (set the limit through an injectable option so the test can use 3, not 300)
  - the unavailable extension → 503 before any auth (no token, still 503)
  - routes follow the table revision (unchanged behaviour test kept green)
- [ ] **Step 2: run** `pnpm exec vitest run packages/kernel/test/http/plugin-route-access.test.ts` → FAIL.
- [ ] **Step 3: implement** — move the 503 gate, matching and `access.resolve` into a scope `onRequest` hook (store `{route, caller}` on the request via a `WeakMap<FastifyRequest, …>`), the handler stage builds the web request and calls `route.handler(webReq, caller)`; `toWebRequest` also drops an Authorization header carrying a kernel token; router uses `find-my-way` `find()` params and HEAD → GET fallback returning the GET record. `ApiError` from `resolve` maps to its status and envelope; other errors → 500 `internal` (logged). Replace the Task 2 temporary `{access:"public"}`. Update the module doc comment (routes are no longer unauthenticated; the `model.hook_denied` note).
- [ ] **Step 4: run** the new file, `packages/kernel/test/http`, `packages/kernel/test/ui`, `packages/kernel/test/extensions` → PASS; `pnpm typecheck && pnpm lint && pnpm check` → PASS.
- [ ] **Step 5: commit** `feat(kernel): enforce extension route access before the handler`.

### Task 4: docs

**Files:**
- `.agents/skills/writing-extensions/SKILL.md` (extension routes section: the four levels, mounts, caller, PAT only, credential stripping, throttle, "trust only `caller.orgId`")
- `.agents/skills/writing-extension-ui/SKILL.md` (embed data routes use `access: "embed"` + `caller`; pages are public GETs; tokens are not bound to a route — check `caller.contribution` / `caller.role`)
- `docs/superpowers/specs/2026-10-18-extension-model-design.md` (Ruling A2: mark retired, pointer to the new spec)
- the architecture spec example with `public: true` (`git grep -n "public: true" -- docs .agents`), `docs/architecture.md` if it describes routes as unauthenticated
- code comments saying extension routes are unauthenticated (`git grep -n -i "unauthenticated\|免登录\|不经内核鉴权" -- packages/kernel/src packages/plugin-sdk/src`)
- `docs/deploy/upgrade.md`: note that extensions with routes need re-approval and plugins must declare access

- [ ] **Step 1:** edit; **Step 2:** `pnpm check` (docs links, i18n unaffected) → PASS; **Step 3:** commit `docs: extension route access`.

## Execution waves

- Wave 1: Task 1 (sonnet-class implementer, standard review).
- Wave 2: Task 2 (standard).
- Wave 3: Task 3 alone on the most capable model, reviewed alone on the most capable model.
- Wave 4: Task 4, then a whole-branch review, `pnpm verify`, PR, CI, merge.
- After the SDK release: plugins repo (`example-board`, `example-counter`) in its own worktree/PR.
