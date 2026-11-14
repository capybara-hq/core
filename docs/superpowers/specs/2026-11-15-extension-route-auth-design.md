# Extension route access: the kernel authenticates every extension route

- date: 2026-11-15
- status: approved direction (maintainer, 2026-11-15); details decided here after an independent
  design review
- input: design review 2026-11-14 finding `extension-routes-bypass-auth` (high); retires
  Ruling A2 of `2026-10-18-extension-model-design.md` (`public` is only a declaration)
- scope: `@capybara-hq/plugin-sdk` (manifest, `ctx.http.route`), `@capybara-hq/plugin-tools`
  checks, the kernel's plugin dispatch and approval, the core fixtures, and the two plugins in
  `capybara-hq/plugins` that register routes

## Problem

`ctx.http.route` mounts a handler at `/plugins/<name><path>` in a Fastify scope outside Nest: no
`AuthGuard`, no throttle, and the handler receives no caller. `permissions.http[].public` is shown at
review but enforced nowhere (Ruling A2), so every extension endpoint is anonymous. An author who
assumes kernel authentication leaks org data, and approval cannot tell a webhook from a member
endpoint. A kernel fixture already lets anyone call `ctx.models.embed` for any org through a route.

## Decision

Every entry of `permissions.http` declares `access`. The kernel enforces it before the request body
is read and before the handler runs, and passes the handler the caller it established.

| `access` | Who may call | Mounted at | The handler's `caller` |
|---|---|---|---|
| `public` | anyone | `/plugins/<name><path>` | `{ access: "public" }` |
| `embed` | a valid embed token of this extension (Bearer or `?token=`) | `/plugins/<name><path>`, path under `/ui/` | see below |
| `member` | a person with a personal API token who is a member (role ≥ `member`) of the org in the URL, the extension enabled there | `/plugins/<name>/orgs/:orgId<path>` | `{ access: "member", orgId, accountId, role, config }` |
| `admin` | as `member` with role ≥ `admin` | `/plugins/<name>/orgs/:orgId<path>` | `{ access: "admin", orgId, accountId, role, config }` |

The `embed` caller is a union mirroring the embed token's scopes:
`{ access: "embed", scope: "org", orgId, accountId, role, contribution, conversationId?, exp, config }` or
`{ access: "embed", scope: "platform", accountId, role: "superAdmin", contribution, exp }`. `exp` is
the token's expiry (Unix seconds), so a long-lived response (SSE) can end when the token does.

`config` is the extension's effective config for that org (platform deployment config plus the org's
copy of overridable fields), as on every other org-bound extension call; an org whose effective config
is invalid gets no call (409 `extension.needs_config`).

`public?: boolean` is removed; `access` is required (pre-0.1.0: no compatibility reading).

### Manifest rules (SDK validator, so an undeclared route cannot be imported or approved)

- `access` is one of the four values; a missing or unknown value is refused.
- `embed` paths start with `/ui/`; `member` / `admin` paths contain no `:orgId` parameter.
- `public` and `embed` paths must not start with `/orgs/` (that segment is reserved for the org mount).
- An embed UI contribution's `path` must be declared as a `GET` with `access: "public"`: the
  sandboxed iframe loads the page before it holds a token.

### Why these levels

- `public` covers what must be anonymous: a signed webhook, and an embed's HTML and script. It stays
  sensitive at review (Ruling A5).
- `embed` replaces each extension calling `ctx.ui.verifyEmbedToken` itself on its data routes; the
  kernel runs the same verification (signature, TTL, scope, live membership, the contribution slot's
  `minRole`, the extension enabled in the org) and the extension can no longer forget. A token is not
  bound to one route: any embed route of the extension accepts any valid token of the extension, so
  the caller carries `contribution` and the live `role` and the extension decides role-specific data
  on them (stated in the skill).
- `member` / `admin` follow the kernel API: the org comes from the URL; a non-member, an org where the
  extension is off, or a deleted org gets 404 `org.not_found` (no existence leak); a lower role gets
  403 `forbidden`.

### Details

- **Credentials** for `member` / `admin`: a personal API token (`Authorization: Bearer cap_pat_…`)
  only. Session cookies are not accepted on extension routes (the web app does not proxy them, and
  accepting cookies would add CSRF and same-site CORS exposure); service tokens are refused (403)
  until a consumer needs them. An account that must change its password gets
  `auth.password_change_required`; a disabled account `auth.account_disabled`; no or an invalid token
  `auth.required` (401).
- **The handler never sees kernel credentials**: the dispatch keeps stripping `cap_at` / `cap_rt`
  and also removes an `Authorization` header that carries a kernel token (`cap_pat_` / `cap_svc_`);
  an embed token stays.
- **Order**: the 503 `extension.unavailable` gate runs first (a revoked extension's routes are gone,
  so its access is unknown), then route matching, authentication, authorization, throttling, all in
  the plugin scope's `onRequest` hook before the body is read (as the org upload hook does), then the
  handler. A refusal never reaches the handler.
- **Matching**: the route record carries its `access` and the dispatch uses the matched record's
  access (HEAD falls back to the GET route and its access). The router returns path parameters; the
  dispatch reads `orgId` from them. Duplicate detection uses the full mounted path.
- **Throttling**: `public` routes with an unsafe method (POST / PUT / DELETE) get a per-client-IP
  limit of 300 requests per minute per extension (Redis-backed, `rate_limited` 429). GET / HEAD and
  authenticated routes are not throttled in this change.
- **Errors** reuse existing codes: `auth.required`, `auth.password_change_required`,
  `auth.account_disabled`, `forbidden`, `org.not_found`, `extension.needs_config`, `rate_limited`,
  `extension.unavailable`.
- **SDK**: `ctx.http.route(method, path, handler)` keeps its shape; the handler becomes
  `(req: Request, caller: RouteCaller) => Promise<Response>`. The route's access comes only from the
  manifest entry with the same method and path. `ctx.ui.verifyEmbedToken` stays for tokens used
  elsewhere. A handler trusts only `caller.orgId`, never an org in the URL, query or body.
- **Approval**: the snapshot key becomes `permissions.http.<access>:<METHOD> <path>` (`access` values
  match the key pattern); changing a route's access is a new item (re-approval). `public` and `embed`
  are sensitive at review.
- **Not in scope**: a web proxy for `member` routes, cookie or service-token access, super-admin
  routes, throttling authenticated or GET routes, binding embed tokens to one route.

## Changes

- plugin-sdk: `HttpPermission` `{ method, path, access }` and the manifest rules above; `RouteCaller`
  and the handler signature; the JSON schema entry for `permissions.http`; `gen:sdk-api` and a
  changeset (breaking for route authors).
- plugin-tools: `perm-http` and pack validation follow the new field.
- kernel: `create-ctx` records each route's access and mounted path; the plugin dispatch resolves the
  caller per access in `onRequest` (router returns params), strips kernel credentials, throttles
  public writes; a membership-and-enablement query for `member` / `admin` (role levels, enabled
  extension, live org, account state) modelled on `currentEmbedRole`; the effective config lookup
  used by other org-bound calls; snapshot keys and review display.
- core fixtures and tests: every fixture route declares its access (probes `public`, embed data routes
  `embed`, `embed-consumer` `member` using `caller.orgId`); tests for each level, each refusal code,
  credential stripping, guests, an org where the extension is off, needsConfig, the reserved `/orgs/`
  prefix, HEAD, the throttle, and re-approval on an access change.
- docs: writing-extensions and writing-extension-ui skills (core and plugins), the extension-model
  spec (A2 retired, pointer here), the architecture spec's `public: true` example, the code comments
  that call routes unauthenticated.
- plugins repo (after an SDK release carrying this): `example-board` (`/ui/board*` `public`, data
  routes `embed` reading `caller`), `example-counter` (`public`, a deployment-wide demo).

## Rollout and risk

- The SDK validator refuses a manifest without `access`, so the two published example plugins cannot
  be imported by a kernel with this change until their next release; neither is a bootstrap plugin,
  and no other official plugin registers routes.
- Existing approval snapshots hold the old `permissions.http:` keys, so on an existing deployment an
  extension with routes waits for re-approval and its routes answer 503 meanwhile (pre-0.1.0).
- Order: core PR (SDK + kernel) → SDK release → plugins PR → plugins release.
