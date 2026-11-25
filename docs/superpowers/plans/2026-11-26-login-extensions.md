# Login Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, with the wave plan of `wave-planned-subagent-development` below. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Third-party sign-in is turned on, ordered and trusted from the admin console / `Platform`, unlinked external accounts go to a link page, and people see one "linked accounts" page.

**Architecture:** A kernel-owned `deployment_settings` row `loginSources` replaces the startup keys `auth.loginSources` / `auth.trustedIdentitySources`; `SsoFlow` gains an `intent` (`signin` / `link`) and a Redis-held link ticket that the link page redeems with a password; `/me/identities` reports capabilities; the web adds the 登录 section, the 登录方式 order list, the link page and the renamed linked accounts page.

**Tech Stack:** NestJS + Fastify kernel, Kysely/PG, ioredis, zod (`createZodDto`), Next web on `@capybara-hq/design`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-26-login-extensions-design.md` (read it with this plan; section numbers below are the spec's).

## Global Constraints

- Setting key `loginSources` in `capybara.deployment_settings`, value `LoginSourceSettings[]` (spec §1), array order = login page order; read from PG per use, never cached in process.
- `signUp: "link" | "create"`, default `"link"`; `trustedTenants` at most 50 per source; keys built as `${plugin}:${tenant}`.
- `auth.loginSources` and `auth.trustedIdentitySources` deleted from `KernelConfigSchema` and their hot listeners; `auth` stays a `strictObject`.
- Link ticket `cap_link_<32 bytes base64url>`, Redis `capk:sso-link:<sha256(ticket)>`, TTL 600 s, single use on success, burned after 5 wrong passwords; it keeps the `cap_sso` binding cookie.
- Login error codes added: `sso.link_expired`. API error codes added: `login_sources.needs_config`, `login_sources.unknown_plugin`, `login_sources.invalid_tenant`. Existing `identity.taken`, `auth.account_disabled`, `auth.invalid_credentials`, `auth.rate_limited` reused.
- Audit actions: `login_sources.updated` (before/after), `identity.linked` with `via: "oauth" | "link_page"`, `identity.verified` (bind → sso).
- Model-facing text English; UI text zh + en via i18n; zh says 平台 / 超级管理员, never 企业 / `agent`.
- No release and no production upgrade in this line; every PR: `pnpm verify --fast` + the touched tests, CI green, reported for the main session to merge.

## Review Focus

1. A settings entry whose extension is uninstalled then reinstalled: kept, not offered while missing, offered again on return (Task 2 test `keeps an entry of an unloaded extension`).
2. A `link`-intent callback that arrives signed out or as another account (session expired, other tab signed in elsewhere): `sso.session_mismatch`, never an account creation or session switch (Task 4 test `link intent without the same session`).
3. Double submit of the link form (two tabs, double click): exactly one identity row, the second request `sso.link_expired` (Task 4 test `link ticket is single use under concurrency`).
4. Link page with a disabled account or a must-change-password account: disabled refused without consuming the ticket's attempts; must-change goes to change-password like a password sign-in (Task 4 tests).
5. A super admin switches a source off mid-flow: the callback answers `sso.unavailable` and a pending link POST answers `sso.link_expired`; no identity row is written (Task 4 test `source switched off between start and callback`).

---

## Wave plan (wave-planned-subagent-development)

| Wave | Tasks (parallel within a wave: disjoint files) | Review |
|---|---|---|
| 1 | Task 1 (SDK) | batched with wave 2 |
| 2 | Task 2 (settings service, startup keys removed) | alone, most capable model (trust: merge rules) |
| 3 | Task 3 (admin routes + `Platform`) ‖ Task 4 (SSO intent, decision table, link page API) | Task 4 **alone on the most capable model** (trust boundary: SSO, binding page); Task 3 batched |
| 4 | Task 5 (`/me/identities` + linked accounts page) → Task 6 (admin 登录 section + 登录方式 order) → Task 7 (link page + bind card copy) | batched; run sequentially in one worktree or in parallel worktrees rebased in order: all three add keys to `apps/web/messages/{zh,en}.json` (separate namespaces) |
| 5 | Task 8 (docs, skills, e2e seed, changesets) | batched |
| plugins | Task 9 (capybara-hq/plugins) | after the core PR merges and the SDK is released by the main session |

Merge order: core PR (SDK + kernel + web, one PR) first; the main session releases the SDK; then the plugins PR (Task 9), rebased on the separate slack/lark sign-in guides PR already open in capybara-hq/plugins.

---

### Task 1: `identity-source@1` tenant declaration (SDK)

**Files:**
- Modify: `packages/plugin-sdk/src/identity.ts` (the `IdentitySource` interface)
- Modify: `packages/plugin-sdk/agent-docs/extension-points/identity-source.md` (via `pnpm gen:agent-docs`, plus one hand-written paragraph)
- Modify: the SDK API report (via `pnpm gen:sdk-api`)
- Create: `.changeset/identity-source-tenant.md` (`@capybara-hq/plugin-sdk`: minor)
- Test: `packages/plugin-sdk/test/identity-tenant.test.ts` (unit; add to the SDK test project if it has a list)

**Interfaces:**
- Produces: `IdentitySourceTenant = { label: {zh,en}; help?: {zh,en}; pattern?: string; placeholder?: string; neverTrusted?: string[] }`, `IdentitySource.tenant?: IdentitySourceTenant`, and `validateTenantId(decl: IdentitySourceTenant | undefined, id: string): "ok" | "pattern" | "never_trusted" | "empty"` exported from the SDK (pure; the kernel and the web both use the same rule).

- [ ] **Step 1: Write the failing test** `validateTenantId`: `(slackDecl, "T0123ABCD") → "ok"`, `(slackDecl, "E0123") → "pattern"`, `(googleDecl, "consumer") → "never_trusted"`, `(undefined, "anything") → "ok"`, `(undefined, " ") → "empty"`; `slackDecl.pattern = "^T[A-Z0-9]+$"`, `googleDecl.neverTrusted = ["consumer"]`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/identity-tenant.test.ts` → FAIL (not exported).
- [ ] **Step 3: Implement** the type and `validateTenantId` in `identity.ts` (trim first; an invalid `pattern` string counts as no pattern).
- [ ] **Step 4: Run** the test → PASS; `pnpm gen:sdk-api && pnpm gen:agent-docs`; add to the identity-source topic: "Declare `tenant` so the admin console can label and check trusted tenants; list tenants that must never be trusted in `neverTrusted`."
- [ ] **Step 5: Verify** `pnpm check:sdk-api && pnpm check:agent-docs && pnpm typecheck` → pass.
- [ ] **Step 6: Commit** `feat(sdk): identity sources declare their tenant`.

### Task 2: Login sources setting; startup keys removed

**Files:**
- Create: `packages/kernel/src/identity/login-sources.ts` (`LoginSourcesService`, `@Injectable`, provided in `identity.module.ts`)
- Modify: `packages/kernel/src/config/schema.ts` (delete `auth.loginSources`, `auth.trustedIdentitySources`, their defaults, `TRUSTED_SOURCE_RE` if unused)
- Modify: `packages/kernel/src/infra/config/kernel-config.service.ts` (delete the two hot listeners)
- Modify: `packages/kernel/src/identity/sso.ts` (`sources()` / `provider()` read the service; `provider()` becomes async)
- Modify: `packages/kernel/src/identity/external.ts` (`trusted(source)` → `await this.loginSources.isTrusted(source)`)
- Modify: `docs/config.md` (`pnpm gen:config-docs` or the repo's generator, see `adding-config`)
- Create: `packages/testing/src/login-sources.ts` (`seedLoginSources(app, entries)` writing the row through the service) and export it
- Modify tests that set the removed keys: `packages/kernel/test/identity/{sso.http,external,account-people}.test.ts`, `test/config/{fields,auth-trust}.test.ts`, `test/extensions/inflight.test.ts`, `test/channels/m4-segment1.dual.test.ts` (use `seedLoginSources`; `auth-trust.test.ts` becomes the trust test of the service)
- Test: `packages/kernel/test/identity/login-sources.test.ts` (integration: needs PG)

**Interfaces:**
- Consumes: `validateTenantId`, `IdentitySourceTenant` (Task 1).
- Produces:
  ```ts
  type LoginSourceSettings = { plugin: string; enabled: boolean; signUp: "link" | "create"; trustedTenants: string[] };
  class LoginSourcesService {
    list(): Promise<LoginSourceSettings[]>;                       // stored order
    enabled(): Promise<{ plugin: string; source: IdentitySource; settings: LoginSourceSettings }[]>; // enabled AND loaded AND providing the point, in order
    get(plugin: string): Promise<LoginSourceSettings | undefined>;
    isTrusted(sourceKey: string): Promise<boolean>;               // `${plugin}:${tenant}` in an entry's trustedTenants
    update(plugin: string, patch: Partial<Omit<LoginSourceSettings, "plugin">>, actorId: string): Promise<LoginSourceSettings>; // @Transactional, audit login_sources.updated; enabling appends to order
    reorder(plugins: string[], actorId: string): Promise<LoginSourceSettings[]>; // must be a permutation of the enabled ones
  }
  ```
  Errors: `login_sources.unknown_plugin` (no loaded identity-source extension and no stored entry), `login_sources.invalid_tenant` (`validateTenantId` not ok; message names the tenant and the reason), `login_sources.needs_config` (enabling while `registry` reports the deployment config invalid). Register the codes in `packages/kernel/src/errors.ts`.

- [ ] **Step 1: Write the failing tests** in `login-sources.test.ts`: `update enables and appends to the order`; `reorder rejects a non-permutation`; `invalid tenant is refused with login_sources.invalid_tenant` (fake-im declares no tenant → only empty refused; a test identity source with `pattern: "^T"` refuses `"X1"`); `isTrusted matches the full key only`; `keeps an entry of an unloaded extension` (stored entry stays in `list()`, absent from `enabled()`, returns after the extension loads); `enabling with invalid deployment config → login_sources.needs_config`; `writes audit login_sources.updated with before and after`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/identity/login-sources.test.ts` → FAIL.
- [ ] **Step 3: Implement** the service on `deployment_settings` (upsert by key; zod-parse the stored value, an invalid row logs a warning and reads as `[]`, as `SettingsService.get` does).
- [ ] **Step 4: Remove** the two config keys and listeners; switch `SsoFlow` and `ExternalIdentities` to the service; replace the removed keys in the listed tests with `seedLoginSources`.
- [ ] **Step 5: Run** `pnpm exec vitest run packages/kernel/test/identity packages/kernel/test/config packages/kernel/test/extensions/inflight.test.ts` and `pnpm exec vitest run --project container packages/kernel/test/channels/m4-segment1.dual.test.ts` → PASS; `pnpm typecheck && pnpm check` → pass (regenerate `docs/config.md`).
- [ ] **Step 6: Commit** `feat(kernel): login sources are a deployment setting, not startup config`.

### Task 3: Admin routes, `Platform` operations, the config hint

**Files:**
- Create: `packages/kernel/src/admin/login-sources.controller.ts`, `packages/kernel/src/admin/login-sources.schemas.ts` (provide in `admin.module.ts`)
- Modify: `packages/kernel/src/platform/route-schemas.ts` (register the three routes)
- Modify: `packages/kernel/src/platform/ops/admin.ops.ts` (three operations) and `packages/kernel/src/platform/ops/extensions-admin.ops.ts` (`extensions.platform-config` adds `next` for identity-source extensions)
- Test: `packages/kernel/test/admin/login-sources.http.test.ts`; parity covered by `tools/checks/test/platform-parity.test.ts`

**Interfaces:**
- Consumes: `LoginSourcesService` (Task 2), `ssoCallbackPath` + `http.publicUrl` for the callback URL.
- Produces routes (all `@SuperAdmin`):
  - `GET /api/v1/admin/login-sources` → `{ items: { plugin; label: {zh,en}; tenant?: IdentitySourceTenant; enabled; signUp; trustedTenants; available: boolean; needsConfig: boolean; callbackUrl: string | null }[] }` (enabled first in order, then the rest by plugin name)
  - `PUT /api/v1/admin/login-sources/:plugin` body `{ enabled?: boolean; signUp?: "link" | "create"; trustedTenants?: string[] }` (max 50 items, each ≤ 214 chars) → the item
  - `PUT /api/v1/admin/login-sources/order` body `{ plugins: string[] }` → `{ items }`
  - Operations `login-sources.list`, `login-sources.update`, `login-sources.reorder` (`authz` super admin, `example`s with `slack`, descriptions in English stating the effect on the login page; `update`'s `errors` give `next` for the three codes, `needs_config` → "fill in the deployment config with extensions.platform-set-config, following extensions.platform-guides").
  - `extensions.platform-config` for an extension providing `identity-source@1`: `next: "Its sign-in is turned on and its trusted tenants set with login-sources.update."`

- [ ] **Step 1: Write the failing tests**: `lists loaded identity sources with callbackUrl`; `non super admin gets 403`; `update then GET /api/v1/auth/sources shows it at once`; `order route reorders the login page`; `invalid tenant → 400 login_sources.invalid_tenant`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/admin/login-sources.http.test.ts` → FAIL.
- [ ] **Step 3: Implement** the controller and schemas (`createZodDto`, `@ZBody` / `@ZParam`), then the operations built from the schemas.
- [ ] **Step 4: Run** the test, `pnpm exec vitest run tools/checks/test/platform-parity.test.ts`, `pnpm check:platform-ops && pnpm check:kernel-conventions && pnpm check:web-api-parity` → PASS.
- [ ] **Step 5: Commit** `feat(kernel): admin routes and Platform operations for login sources`.

### Task 4: SSO intent, the decision table, the link page API (trust boundary)

**Files:**
- Modify: `packages/kernel/src/identity/sso.ts` (`start(..., intent)`, callback decisions), `packages/kernel/src/identity/sso.controller.ts` (`start` reads `intent` query; callback branch to the link page keeps `cap_sso`; new link routes), `packages/kernel/src/identity/external.ts` (a `linkVerified(accountId, identity, via)` that inserts as `sso` or upgrades `bind` → `sso`, under the identity lock; `resolve` no longer creates when told not to)
- Create: `packages/kernel/src/identity/sso-link.ts` (`SsoLinkTickets`: create / peek / redeem)
- Modify: `packages/kernel/src/platform/exclusions.ts` (two `human-only` exclusions: "a person's own sign-in with a password")
- Modify: `apps/web/src/lib/auth-sources.ts` (`LOGIN_ERROR_CODES` gains `sso.link_expired`; web types for the link routes)
- Test: `packages/kernel/test/identity/sso-link.test.ts` (integration), `packages/kernel/test/identity/sso-decisions.unit.test.ts` (unit; add to `unit-tests.json`), `packages/kernel/test/identity/sso-link.dual.test.ts` (container; add to `container-tests.json`)

**Interfaces:**
- Consumes: `LoginSourcesService.enabled()/get()` (Task 2), `AccountsService.authenticateLocal`, `CredentialThrottler` with `LOGIN_THROTTLERS` (export it from `auth.controller.ts`), `SessionService.create`, `setSessionCookies`.
- Produces:
  - `GET /api/v1/auth/sso/:plugin/start?returnTo` is a sign-in only (`intent=link` → login page `sso.session_mismatch`, no state); `POST /api/v1/auth/sso/:plugin/start` body `{ intent: "link"; returnTo? }` (web session only, CSRF header) → `{ location }` + the `cap_sso` cookie: the link intent's start (web helper `startLink(plugin, returnTo)`).
  - Pure decision `decideSsoCallback(input: { intent: "signin" | "link"; sessionAccountId?: string; row?: { accountId: string; linkedVia: "bind" | "sso" | "directory" | null }; mergeTarget?: string; signUp: "link" | "create" }): { kind: "signin"; accountId } | { kind: "linked"; accountId } | { kind: "upgrade"; accountId } | { kind: "link_page"; existingAccountId?: string } | { kind: "create" } | { kind: "error"; code: SsoLoginError | "identity.taken" }` in `sso.ts`, implementing spec §4's table cell by cell.
  - `GET /api/v1/auth/sso/link?ticket=` (public, needs `cap_sso`) → `{ plugin; label; tenantId; displayName; avatarUrl?; linkedToAnother: boolean }`.
  - `POST /api/v1/auth/sso/link` body `{ ticket; login; password }` (public, CSRF header as `/auth/login`) → `{ account, returnTo }` + session cookies; errors `auth.invalid_credentials`, `auth.rate_limited`, `auth.account_disabled`, `identity.taken`, `sso.link_expired`.

- [ ] **Step 1: Write the failing unit tests** in `sso-decisions.unit.test.ts`, one per cell of spec §4's table (10 cells), e.g. `link intent, row of A as bind → upgrade A`, `signin, no row, signUp link → link_page`, `signin, row of B as bind → link_page`, `link intent, row of B → identity.taken`, `link intent, merge target B, session A → linked A`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/identity/sso-decisions.unit.test.ts` → FAIL.
- [ ] **Step 3: Implement** `decideSsoCallback` and wire it into `SsoFlow.callback` (state records `intent`; a `link` intent requires the same session at callback).
- [ ] **Step 4: Write the failing integration tests** in `sso-link.test.ts` with `fake-im`'s identity source and `startFakeOAuthServer({ oidc: {} })` where the flow needs OIDC: `unlinked sign-in lands on the link page`; `link page links and signs in` (identity `sso`, audit `via: link_page`); `link page upgrades a bind row of the same account`; `link page refuses a bind row of another account with identity.taken`; `wrong password five times burns the ticket`; `link ticket is single use under concurrency` (two parallel POSTs → one 200, one `sso.link_expired`, one row); `disabled account → auth.account_disabled, attempts kept`; `must-change-password account signs in and is sent to change-password`; `binding cookie mismatch → sso.session_mismatch`; `link intent without the same session → sso.session_mismatch, no account created`; `link intent links to the signed-in account, session unchanged`; `signUp create keeps creating accounts`; `trusted email merge reads the setting`; `source switched off between start and callback → sso.unavailable, no row`.
- [ ] **Step 5: Run** `pnpm exec vitest run packages/kernel/test/identity/sso-link.test.ts packages/kernel/test/identity/sso.http.test.ts` → FAIL, then implement `SsoLinkTickets` (Redis `SET … EX 600`, attempts in the record via a Lua or `WATCH`-free `GETDEL` + re-`SET` with `KEEPTTL`; redeem is `GETDEL` before the password check result is applied, re-stored with attempts+1 on a wrong password) and the routes → PASS.
- [ ] **Step 6: Write and run** `sso-link.dual.test.ts`: start on replica 1, callback and link POST on replica 2 → signed in, one row. `pnpm exec vitest run --project container packages/kernel/test/identity/sso-link.dual.test.ts` → PASS.
- [ ] **Step 7: Verify** `pnpm check:platform-ops && pnpm check:kernel-conventions && pnpm check:web-api-parity && pnpm typecheck` → pass.
- [ ] **Step 8: Commit** `feat(kernel): link page for unlinked sign-ins and link intent`.

### Task 5: Linked accounts (`/me/identities` capabilities + page)

**Files:**
- Modify: `packages/kernel/src/identity/external.ts` (`LinkedIdentity` gains `channel: boolean`, `login: "unsupported" | "off" | "needs_link" | "on"`; computed in `MeIdentitiesController.list` from the registry and `LoginSourcesService`) and `sso.controller.ts` (`MeIdentitiesController`)
- Modify: `apps/web/src/lib/identities.ts` (type), `apps/web/src/app/(app)/account/identities/view.tsx`, the account nav label, `apps/web/messages/{zh,en}.json` (`identities.*`, nav `identities`: 「已绑定账号」 / "Linked accounts")
- Test: extend `packages/kernel/test/identity/sso.http.test.ts` (`me identities report capabilities`), `apps/web/src/app/(app)/account/identities/view.test.tsx`

**Interfaces:**
- Consumes: `LoginSourcesService.enabled()` (Task 2); `POST …/start` `{ intent: "link" }` via `startLink` (Task 4).
- Produces: the page described in spec §6 — columns 账号 / 平台 / 租户 / IM / 登录; 「启用登录」 row action and 「绑定 <平台>」 buttons call `startLink(plugin, "/account/identities")` and navigate to the returned `location`; link-intent errors come back as `?error=<code>` on the page; no 「未验证」 badge.

- [ ] **Step 1: Write the failing tests**: kernel `me identities report capabilities` (fake-im row: `channel: true`; login `off` before enabling, `needs_link` for a bind row after enabling, `on` for an sso row; a plugin without identity-source → `unsupported`); web view test: `shows 绑定 for an enabled source without an identity`, `no 未验证 badge`, `启用登录 on a needs_link row`, `不支持 for telegram-like rows`.
- [ ] **Step 2: Run** both → FAIL.
- [ ] **Step 3: Implement** kernel fields, web type, view (DataTable + design components only, strings through i18n).
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/identity/sso.http.test.ts apps/web/src/app/\(app\)/account/identities` and `pnpm check:web-ui && pnpm check:i18n && pnpm check:web-api-parity` → PASS.
- [ ] **Step 5: Commit** `feat(web): linked accounts page with IM and sign-in capabilities`.

### Task 6: Admin 登录 section and 登录方式 order

**Files:**
- Create: `apps/web/src/lib/login-sources.ts` (`loginSourcesQuery` via `defineQuery`, `updateLoginSource`, `reorderLoginSources`)
- Create: `apps/web/src/components/admin/LoginSourceSection.tsx`, `apps/web/src/components/admin/LoginMethodsSection.tsx`
- Modify: `apps/web/src/app/(app)/admin/extensions/[name]/view.tsx` (render `LoginSourceSection` when the item is in `loginSourcesQuery`), `apps/web/src/app/(app)/admin/settings/view.tsx` (render `LoginMethodsSection`), the route table / prefetch if the page reads a new query, `apps/web/messages/{zh,en}.json` (`loginSources.*`)
- Test: `apps/web/src/components/admin/LoginSourceSection.test.tsx`, `LoginMethodsSection.test.tsx`

**Interfaces:**
- Consumes: Task 3 routes; `validateTenantId` rule mirrored in the web (the web does not import the SDK: copy the three-line check into `lib/login-sources.ts` with a comment naming the SDK function, or rely on the server error).
- Produces: 登录 section (`FormSection`: switch 「在登录页显示」, radio 「未绑定的账号」 去绑定页（推荐）/ 自动注册新账号, list field 「可信租户」 labelled by `tenant.label` with `placeholder`/`help` and the trust warning, read-only callback URL with copy); disabled switch with 「先填写部署配置」 when `needsConfig`. 登录方式 section: the design `Repeater` in order mode (drag handle, move buttons, Alt+↑/↓) over the enabled items, each linking to `/admin/extensions/<plugin>`; disabled items listed below without reorder; saves through `reorderLoginSources`.

- [ ] **Step 1: Write the failing tests**: `toggling 在登录页显示 calls update`, `needsConfig disables the switch with the hint`, `a tenant failing the pattern shows the field error`, `reorder by move button saves the new order`, `disabled sources are not reorderable`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/src/components/admin` → FAIL.
- [ ] **Step 3: Implement** with design components only (no `className`, no styles); writes through `useAppMutation` invalidating `loginSourcesQuery`.
- [ ] **Step 4: Run** the tests and `pnpm check:web-ui && pnpm check:i18n` → PASS.
- [ ] **Step 5: Commit** `feat(web): turn login methods on and order them in the admin console`.

### Task 7: Link page and bind card copy

**Files:**
- Create: `apps/web/src/app/(auth)/login/link/page.tsx`, `view.tsx`
- Modify: `apps/web/src/lib/auth-sources.ts` (`peekLink`, `redeemLink`), `apps/web/src/app/(auth)/login/view.tsx` (error text for `sso.link_expired`), `apps/web/src/app/(auth)/bind/[token]/view.tsx` (warning line), `apps/web/messages/{zh,en}.json` (`login.link.*`, `bind.warning`)
- Test: `apps/web/src/app/(auth)/login/link/view.test.tsx`, extend the bind view test

**Interfaces:**
- Consumes: Task 4 routes.
- Produces: `AuthPage` with the identity card (platform label, display name, tenant, avatar), copy 「这个 <平台> 账号（<名称> · <租户>）还没有可登录的 Capybara 账号。用你的用户名和密码登录，完成绑定。」, username / password, 「取消」 → `/login`, 「没有账号？请联系管理员。」; `linkedToAnother` adds 「这个账号已绑定到另一个 Capybara 账号，用那个账号的密码登录即可升级为可登录。」; success follows the same redirect as a password sign-in (including change-password). Bind card adds 「只绑定你本人的账号。如果这个链接是别人发给你的，不要绑定。」

- [ ] **Step 1: Write the failing tests**: `shows the identity and submits credentials`, `identity.taken shows its message`, `expired ticket sends to /login?error=sso.link_expired`, bind view `shows the warning line`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (template + design components, CSRF header through the existing form-post helper).
- [ ] **Step 4: Run** the tests and `pnpm check:web-ui && pnpm check:i18n && pnpm check:web-api-parity` → PASS.
- [ ] **Step 5: Commit** `feat(web): link page for sign-ins without a linked account`.

### Task 8: Docs, skills, e2e seed, changesets

**Files:**
- Modify: `docs/guide/slack-and-lark.md` (enabling and trust through 平台 → 扩展 → 登录; the link page; drop the env examples), `.agents/skills/writing-channels/SKILL.md` (identity-source section: no `auth.loginSources` / `trustedIdentitySources`; `tenant` declaration; the link page), `apps/web/e2e/global-setup.ts` (seed `fake-im` through `PUT /api/v1/admin/login-sources/fake-im` instead of `auth.loginSources`)
- Create: `.changeset/login-extensions.md` (`@capybara-hq/capybara`: patch, release note: remove `CAPYBARA_AUTH__LOGIN_SOURCES` / `CAPYBARA_AUTH__TRUSTED_IDENTITY_SOURCES`, startup fails while set; turn methods on in the console)

- [ ] **Step 1: Edit** the files; `rg -n "loginSources|trustedIdentitySources" --glob '!docs/superpowers/**' --glob '!**/migrations/**'` → only the release note and the spec/plan remain.
- [ ] **Step 2: Run** `pnpm verify --fast` → pass; run the e2e smoke that signs in with fake-im if the e2e project is runnable locally, else rely on CI.
- [ ] **Step 3: Commit** `docs: login methods are turned on in the admin console`.

Open the core PR (`Closes #882`) after Task 8; CI green → report to the main session.

### Task 9: Plugins (capybara-hq/plugins)

**Files:** `plugins/{slack,lark,google}/src/identity.ts` (add `tenant`), their guides (`plugins/google/guides/google-sign-in{,.zh}.md` step 5; the slack / lark sign-in guides from the open guides PR), READMEs (enabling section), the plugins `writing-channels` skill, a changeset per plugin, the SDK dependency bump to the released version.

**Interfaces:** Slack `tenant = { label: {zh:"Slack 工作区 ID", en:"Slack workspace ID"}, pattern: "^T[A-Z0-9]+$", placeholder: "T0123ABCD", help: {…"在 Slack 工作区设置的 URL 或 About this workspace 里"} }`; Lark `{ label: {zh:"飞书租户 key", en:"Lark tenant key"}, help: {…tenant_key from the developer console…} }`; Google `{ label: {zh:"Google Workspace 主域名", en:"Google Workspace primary domain"}, placeholder: "example.com", pattern: "^[a-z0-9.-]+\\.[a-z]{2,}$", neverTrusted: ["consumer"] }`.

- [ ] **Step 1:** Wait for the core PR merge and the SDK release (main session); rebase on the slack/lark guides PR once it merges (do not duplicate its guides; only change the enabling steps).
- [ ] **Step 2:** Add the declarations; unit test each plugin's `tenant` against `validateTenantId` (`T0123ABCD` ok, `E0123` pattern; google `consumer` never_trusted).
- [ ] **Step 3:** Guides: "在本页「登录」区块打开「在登录页显示」，需要时填写可信租户" (en likewise); remove `auth.loginSources` / `auth.trustedIdentitySources` everywhere.
- [ ] **Step 4:** `pnpm verify --fast` in plugins + the touched tests; open the PR; CI green → report.

## Self-review notes

- Spec §1 → Task 2; §2 → Tasks 1, 9; §3 → Tasks 3, 6 (+ guides 8, 9); §4 → Task 4; §5 → Tasks 4, 7; §6 → Task 5; §7 → Task 7; Security → Task 4 tests; Rollout → Task 8; Test plan → per task.
- Names used across tasks: `LoginSourcesService`, `LoginSourceSettings`, `IdentitySourceTenant`, `validateTenantId`, `decideSsoCallback`, `SsoLinkTickets`, `seedLoginSources`.
