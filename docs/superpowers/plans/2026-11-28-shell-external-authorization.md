# Shell external authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with `wave-planned-subagent-development` (wave table at the end). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a native shell, connector OAuth and login-method linking finish in the system browser through a single-use handoff ticket, and the person comes back to the app with the result.

**Architecture:** The two start routes take an optional `handoff: { returnScheme? }`; with it they check what the start checks, store a hashed Redis ticket and return `{ handoffUrl }` instead of setting the binding cookie. The web page `/handoff/<ticket>` (signed in, same account) redeems it, which runs the existing `flow.start` in the system browser with a fresh binding cookie and a return path to `/handoff/done` that the kernel builds from the ticket (scheme, original return path). The done page shows the result and a `<scheme>://open?url=…` link back into the app. The web opens the browser through `openExternal@1` and refreshes on focus; the desktop never navigates a profile window off its origin.

**Tech Stack:** NestJS + Fastify kernel (ioredis, zod, `createZodDto`), Next web app (TanStack Query, next-intl, `@capybara-hq/design`), vitest (jsdom for web), Electron desktop and Capacitor mobile in `capybara-hq/clients`.

**Spec:** `docs/superpowers/specs/2026-11-28-shell-external-authorization-design.md` (approved 2026-11-28).

## Global Constraints

- Ticket: `cap_ho_` + 32 random bytes base64url (regex `^cap_ho_[A-Za-z0-9_-]{43}$`); Redis key `capk:handoff:<sha256(ticket) base64url>`; TTL 600 s; taken with `GETDEL`; single use. Redis holds only the hash.
- `handoffUrl` = `<http.publicUrl without trailing />/handoff/<ticket>`.
- `returnScheme` is accepted only when `<returnScheme>://auth/callback` is in `auth.appRedirectUris` (exact string match) and `http.publicUrl` is set (the same condition as `features.appSignIn`); else `handoff.scheme_not_allowed`.
- Error codes (registered in `packages/kernel/src/errors.ts`): `handoff.scheme_not_allowed` 400, `handoff.invalid` 410, `handoff.account_mismatch` 403 (details `[{ login, displayName, email }]` of the ticket's account; `login` null without a local login).
- zh copy (verbatim from spec §6): 这个平台还没有允许该应用打开浏览器授权，请联系平台管理员。 / 这个授权链接已经失效或用过了。回到应用里重新点「连接」。 / 这个链接属于 {login}。请用该账号登录，或回到应用重新发起。 Dialog title 「在浏览器中完成授权」, buttons 「复制链接」 「完成了」 「取消」; handoff status 「正在打开授权页…」; done page 「回到 Capybara」, 「换个账号登录」. zh says 平台 / 超级管理员 / 智能体, never 企业 or the Latin `agent`.
- Callback routes, OAuth state lifetime, token exchange, `connector@1` and `identity-source@1` do not change.
- Shell features detected only through `window.capybaraShell` (`apps/web/src/lib/shell.ts`); capability functions called only from event-driven code.
- Web pages: template + design components, no styles; reads `defineQuery`, writes `useAppMutation`; thin server `page.tsx` + client `view.tsx`.
- Comments, identifiers, commits in English (`check:english-comments`); Conventional Commits, body lines ≤ 100; commits end with `Co-Authored-By: Capybara <noreply@capybarahq.com>`.
- Changesets: `@capybara-hq/kernel`, `@capybara-hq/capybara` (fixed with web), `@capybara-hq/plugin-sdk` (shell capability type; `pnpm gen:sdk-api`). Clients: a changeset for desktop, mobile and `@capybara-hq/shell`.
- Before pushing: `pnpm verify --fast` plus `pnpm exec vitest run <changed tests>` (from the repo root).

## Review Focus

1. **A ticket redeemed while signed in as someone else** must burn the ticket and name the owner, never start a flow for the session's account: K2 test `account mismatch burns the ticket`.
2. **React dev double-mount of the handoff page** (StrictMode runs effects twice) must not redeem twice and show `handoff.invalid` to a person whose first redeem succeeded: W2 test `redeems once under a remount`.
3. **A crafted `/handoff/done?scheme=javascript&returnTo=//evil`** must render no back button and no auto-navigation: W2 test `done page refuses unlisted schemes and unsafe returnTo`.
4. **A connector whose OAuth is not configured, or a login method switched off, at start time** must fail at the start in the app (normal error / `?error=` location), not after the person signed in in the browser: K1 tests `handoff start refuses an unconfigured connector` and `link handoff with the source off answers a location`.
5. **The dialog left open after success through the deep link** (the app reloads the page with `connected=`): the result toast shows once and the dialog is gone (page reload), and with the focus path the dialog closes on its own when the connector turns connected: W1 test `closes with success when the connector turns connected`.

---

## File Structure

Kernel (`packages/kernel/src`):
- `handoff/app-schemes.ts` (create): `appSchemes(config)`, `assertReturnSchemeAllowed(config, scheme)`; pure, no Nest.
- `handoff/handoff-tickets.ts` (create): `HandoffTickets` (Redis create / take).
- `handoff/handoff-paths.ts` (create): `HANDOFF_PAGE_PATH`, `HANDOFF_DONE_PATH`, `handoffDonePath(…)`; leaf, imported by both flows.
- `handoff/handoff.service.ts`, `handoff/handoff.controller.ts`, `handoff/handoff.schemas.ts`, `handoff/handoff.module.ts` (create, K2).
- Modify: `errors.ts`, `http/meta.controller.ts`, `tools/oauth/{flow.ts,oauth.controller.ts,oauth.schemas.ts}`, `identity/{sso.ts,sso.controller.ts}`, `platform/ops/connectors.ops.ts`, `platform/exclusions.ts`, `http/api.module.ts`.

Web (`apps/web/src`): `lib/handoff.ts` (API calls + pure helpers), `lib/external-auth.tsx` (context + provider), `components/ExternalAuthDialog.tsx`, `lib/connect.ts`, `app/(app)/account/identities/view.tsx`, `components/shell/AppFrame.tsx`, `lib/shell.ts`, `lib/app-auth.ts`, `app/(auth)/handoff/[ticket]/{layout,page,view}.tsx`, `app/(auth)/handoff/done/{page,view}.tsx`, `messages/{zh,en}.json`.

SDK: `packages/plugin-sdk/src/shell-capabilities.ts`. Docs: desktop spec §7.1 (line ~544) and mobile spec (line ~150).

Clients: `apps/desktop/src/main/security.ts`, `apps/desktop/src/main/capabilities.ts`, `packages/shell/src/*` (capability type), `apps/mobile/src/runtime/capabilities/open-external.ts`, mobile deep-link routing for `open`.

---

### Task K1: Handoff tickets, scheme allowlist and handoff starts (kernel, high)

**Files:**
- Create: `packages/kernel/src/handoff/app-schemes.ts`, `handoff/handoff-tickets.ts`, `handoff/handoff-paths.ts`
- Modify: `packages/kernel/src/errors.ts`, `http/meta.controller.ts`, `tools/oauth/flow.ts`, `tools/oauth/oauth.controller.ts`, `tools/oauth/oauth.schemas.ts`, `identity/sso.ts`, `identity/sso.controller.ts`, `identity/identity.module.ts`, `tools/tools.module.ts`, `platform/ops/connectors.ops.ts`
- Test: `packages/kernel/test/handoff/app-schemes.unit.test.ts` (add to `test/unit-tests.json`), `packages/kernel/test/handoff/handoff-start.test.ts` (integration), extend `test/http/meta*.test.ts` (whichever covers `/api/v1/meta`)

**Interfaces:**
- Produces:
  - `appSchemes(config: KernelConfig): string[]` — schemes `s` for which an entry of `auth.appRedirectUris` equals `${s}://auth/callback` (scheme regex `^[a-z][a-z0-9+.-]{0,31}$`); `[]` when `http.publicUrl` is unset.
  - `assertReturnSchemeAllowed(config, scheme: string | undefined): void` — undefined passes; else throws `ApiError("handoff.scheme_not_allowed", …)` unless `appSchemes(config).includes(scheme)`.
  - `type HandoffRecord = { kind: "connector"; accountId: string; orgId: string; connectorId: string; returnTo: string; returnScheme?: string } | { kind: "identity-link"; accountId: string; plugin: string; returnTo: string; returnScheme?: string }`
  - `class HandoffTickets { create(rec: HandoffRecord): Promise<string /* ticket */>; take(ticket: string): Promise<HandoffRecord | null>; url(ticket: string): string }` (`take` = regex check then `GETDEL`; `url` throws `publicUrlRequired()` without publicUrl). Provided and exported by a `HandoffTicketsModule` declared in `handoff-tickets.ts`, imported by `ToolsModule` and `IdentityModule`.
  - `HANDOFF_DONE_PATH = "/handoff/done"`; `handoffDonePath(rec: HandoffRecord): string` → `/handoff/done?kind=connector&org=<orgId>&connector=<id>&returnTo=<orig>[&scheme=<s>]` or `/handoff/done?kind=identity-link&plugin=<p>&returnTo=<orig>[&scheme=<s>]` (URLSearchParams encoding).
  - `OAuthFlow.start(orgId, connectorId, accountId, returnTo, binding, handoff?: HandoffRecord)`: with `handoff`, the state record's `returnTo` is `handoffDonePath(handoff)`; nothing else changes. Also `OAuthFlow.check(orgId, connectorId, accountId): Promise<void>` — every check `start` makes before writing state (publicUrl, connector exists, `oauth_code`, active, `clientForConnect` has an authorization endpoint), extracted from `start` and called by it.
  - `SsoFlow.start(plugin, returnTo, binding, sessionAccountId, intent, handoff?: HandoffRecord)`: with `handoff`, `back = handoffDonePath(handoff)` (not passed through `safeReturnTo`; kernel-built). Also `SsoFlow.linkAvailable(plugin): Promise<boolean>` (source on offer and publicUrl set).
  - `POST …/connectors/:connectorId/connect` body gains `handoff: { returnScheme?: string }` (strict, optional); with it returns `{ handoffUrl: string }`, sets no cookie, writes no OAuth state. `POST /api/v1/auth/sso/:plugin/start` body likewise; with it returns `{ handoffUrl }`, or `{ location: <returnTo>?error=sso.unavailable }` when `linkAvailable` is false (the same answer as a normal start).
  - `GET /api/v1/meta` gains top-level `appSchemes: string[]`.

- [ ] **Step 1: Write the failing unit test** `app-schemes.unit.test.ts`: `appSchemes` of `appRedirectUris: ["capybara://auth/callback","capy-dev://auth/callback","https://x/cb","capybara://other"]` with publicUrl → `["capybara","capy-dev"]`; without publicUrl → `[]`; `assertReturnSchemeAllowed(cfg, "evil")` throws code `handoff.scheme_not_allowed`; `undefined` passes; `"CAPYBARA"` throws (exact match).
- [ ] **Step 2: Write the failing integration tests** in `handoff-start.test.ts` (one app, fake OAuth server and fake identity source as `test/tools/oauth/oauth.http.test.ts` and `test/identity/sso.http.test.ts` set them up):
  - `connector handoff start returns a handoff URL and no cookie`: response `{ handoffUrl }` matching `^<publicUrl>/handoff/cap_ho_[A-Za-z0-9_-]{43}$`; no `set-cookie` for `cap_oauth`; Redis has `capk:handoff:<sha256>` with TTL in (590, 600] and no `capk:oauth-state:*` key was written.
  - `scheme not allowed → 400 handoff.scheme_not_allowed`.
  - `handoff start refuses an unconfigured connector` (no authorization endpoint → `connector.connect_failed`, no ticket written); a non-`oauth_code` connector → `validation_failed`.
  - `link handoff start returns a handoff URL` (session, CSRF header) and `link handoff with the source off answers a location` ending `?error=sso.unavailable`, no ticket.
  - `a PAT cannot start a link handoff` → `auth.session_required` (unchanged rule).
  - `meta lists appSchemes` (and `[]` without publicUrl).
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/handoff packages/kernel/test/http/meta` — FAIL (module not found / 404 shapes).
- [ ] **Step 4: Implement** the produced interfaces. Register the three codes in `errors.ts` with doc comments. In `OAuthConnectController.connect`, with `body.handoff`: `assertReturnSchemeAllowed`, `await flow.check(...)`, `tickets.create({ kind: "connector", accountId, orgId, connectorId, returnTo: body.returnTo ?? DEFAULT_RETURN_PATH, returnScheme })`, return `{ handoffUrl: tickets.url(ticket) }` with `cache-control: no-store`. In `SsoController.startLink` the same with `returnTo: safeReturnTo(body.returnTo)` and `kind: "identity-link"`. Response type unions are declared in the schemas file. In `connectors.connect` operation add `"handoff"` to `omits` with the comment "a shell's browser handoff; the Platform card starts the flow in the person's web session".
- [ ] **Step 5: Run** the tests of step 3, then `pnpm exec vitest run packages/kernel/test/tools/oauth packages/kernel/test/identity packages/kernel/test/platform` and `pnpm check:platform-ops` — PASS.
- [ ] **Step 6: Commit** `feat(kernel): start connector OAuth and login linking as a browser handoff`.

### Task S1: `openExternal@1.returnScheme` type and spec amendments (normal)

**Files:**
- Modify: `packages/plugin-sdk/src/shell-capabilities.ts`, `apps/web/src/lib/shell.ts` (mirror), the SDK API report (`pnpm gen:sdk-api`), `docs/superpowers/specs/2026-11-07-desktop-client-design.md` (§7.1 line ~544, and line ~87 if it says OAuth runs in the window), `docs/superpowers/specs/2026-11-20-mobile-app-design.md` (line ~150: shells hand connector OAuth / linking to the system browser via the handoff; `open` deep link routed)
- Create: `.changeset/shell-external-authorization-sdk.md` (`@capybara-hq/plugin-sdk: patch`)

**Interfaces:**
- Produces: `interface OpenExternalCapabilityV1 { open(url: string): Promise<void>; /** The shell's own URL scheme, the one in its `<scheme>://auth/callback` (optional). */ readonly returnScheme?: string }` in both copies.

- [ ] **Step 1:** Edit both copies identically; run `pnpm gen:sdk-api`; `pnpm check:sdk-api` and `pnpm typecheck` PASS.
- [ ] **Step 2:** Replace desktop spec §7.1's sentence with: a profile window never navigates off its origin; `will-navigate` / `will-redirect` to another origin are prevented and the http(s) URL goes to `openExternal`; connector OAuth and login linking finish in the system browser (`2026-11-28-shell-external-authorization-design.md`). Amend the mobile spec line likewise (and that the app routes `<scheme>://open?url=` to the matching profile, own origin only).
- [ ] **Step 3: Commit** `feat(plugin-sdk): add returnScheme to openExternal@1` (spec edits in the same commit as `docs(spec): …` if preferred, separate commit).

### Task K2: Redeem route (kernel, high)

**Files:**
- Create: `packages/kernel/src/handoff/handoff.service.ts`, `handoff.controller.ts`, `handoff.schemas.ts`, `handoff.module.ts`
- Modify: `packages/kernel/src/http/api.module.ts` (import `HandoffModule`, add controller), `platform/exclusions.ts`
- Test: `packages/kernel/test/handoff/handoff-redeem.test.ts` (integration), `packages/kernel/test/handoff/handoff.dual.test.ts` (add to `test/container-tests.json`)

**Interfaces:**
- Consumes: K1's `HandoffTickets.take`, `HandoffRecord`, `OAuthFlow.start(..., handoff)`, `SsoFlow.start(..., handoff)`, `browserBinding`, `ssoBrowserBinding`, the binding cookie options of both start controllers (extract each as an exported `setOAuthBindingCookie(reply, binding, config)` / reuse `SsoController`'s private helper as an exported function in `sso.controller.ts` or a small `identity/sso-cookie.ts`).
- Produces: `POST /api/v1/auth/handoffs/redeem` — `@SessionOnly()`, CSRF by the global guard, body `HandoffRedeemBodySchema = z.object({ ticket: z.string().max(100) }).strict()`, answer `{ location: string }` with `cache-control: no-store`. `HandoffService.redeem(ticket: string, accountId: string, binding: { oauth?: string; sso?: string }): Promise<{ location: string; cookie: { name: "cap_oauth" | "cap_sso"; value: string } }>`.

Behavior of `redeem`:
1. `take` → null → `handoff.invalid`.
2. `rec.accountId !== accountId` → load the ticket's account, throw `handoff.account_mismatch` with details `[{ login, displayName, email }]` (ticket already gone).
3. `connector`: `withOrgScope(rec.orgId, …)`: `orgLock.precheck(orgId, accountId, "connectors.use")` then `oauthFlow.start(orgId, connectorId, accountId, rec.returnTo, binding, rec)` → `{ location: authorizationUrl }`, cookie `cap_oauth`.
4. `identity-link`: `ssoFlow.start(rec.plugin, rec.returnTo, binding, accountId, "link", rec)` → `{ location }`, cookie `cap_sso`.
Exclusion: `{ route: "POST /api/v1/auth/handoffs/redeem", category: "human-only", reason: "Redeems a shell's browser handoff in the person's own signed-in browser; it starts an OAuth or SSO flow there" }`.

- [ ] **Step 1: Write failing integration tests** (`handoff-redeem.test.ts`, fake OAuth server + fake identity source, ticket from a real handoff start):
  - `redeem sets the binding cookie and the callback lands on the done page`: redeem → `location` is the fake authorize URL; `set-cookie` `cap_oauth` with Path `/api/v1/oauth/callback`; follow the fake server's redirect to the callback carrying that cookie → 302 to `<publicUrl>/handoff/done?kind=connector&org=…&connector=…&returnTo=%2Fen%2Fsettings%2Fconnectors&scheme=capybara&connected=<id>`; credential stored.
  - `redeem twice → handoff.invalid` (410).
  - `account mismatch burns the ticket`: redeem as account B → 403 `handoff.account_mismatch`, details carry A's email; then redeem as A → `handoff.invalid`.
  - `a member who lost connectors.use is refused`: change role between start and redeem (guest without `connectors.use`, or remove membership) → `forbidden` / `org.not_found`; no OAuth state written.
  - `identity link redeem`: location is the source's authorize URL, `cap_sso` cookie; the callback (same session) succeeds and redirects to `/handoff/done?kind=identity-link&plugin=…&returnTo=…&scheme=…`; a source error lands on the same path with `&error=sso.access_denied`.
  - `redeem without CSRF header → 403`, `with a PAT → auth.session_required`, `unknown or malformed ticket → handoff.invalid`.
  - `no scheme`: a start without `returnScheme` → done path without `scheme`.
- [ ] **Step 2: Write the failing dual-replica test** `handoff.dual.test.ts`: start on replica A, redeem on replica B → 200 with location; a second redeem on A → `handoff.invalid`. Pattern: `test/identity/sso-link.dual.test.ts`.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/handoff` (dual one through the container project as its neighbours run) — FAIL.
- [ ] **Step 4: Implement** service, controller (`@Controller("api/v1/auth/handoffs")`, `@Post("redeem")`, `@HttpCode(200)`, explicit `@Inject` on every constructor parameter, `createZodDto(HandoffRedeemBodySchema, "HandoffRedeemBody")`), module (imports `IdentityModule`, `ToolsModule`, `OrgLockModule`, `HandoffTicketsModule`), exclusion.
- [ ] **Step 5: Run** step 3's tests, `pnpm exec vitest run packages/kernel/test/platform`, `pnpm check:platform-ops`, `pnpm check:kernel-conventions` — PASS. Confirm `redactPath("/handoff/cap_ho_x")` already redacts (the `cap_` rule in `http/error.filter.ts`); add one assertion to its existing test.
- [ ] **Step 6: Commit** `feat(kernel): redeem a browser handoff in the person's signed-in browser`, plus changesets `@capybara-hq/kernel: patch` and `@capybara-hq/capybara: patch` (`.changeset/shell-external-authorization.md`).

### Task W1: The web in a shell opens the browser and waits (normal)

**Files:**
- Create: `apps/web/src/lib/handoff.ts`, `apps/web/src/lib/external-auth.tsx`, `apps/web/src/components/ExternalAuthDialog.tsx`
- Modify: `apps/web/src/lib/connect.ts`, `apps/web/src/lib/connectors.ts` (`connectConnector` body + answer union), `apps/web/src/lib/auth-sources.ts` (`startLink` body + answer union), `apps/web/src/app/(app)/account/identities/view.tsx`, `apps/web/src/components/shell/AppFrame.tsx` (mount the provider), `apps/web/src/lib/app-auth.ts` (`PlatformMeta.appSchemes: string[]`), `apps/web/messages/{zh,en}.json` (namespace `externalAuth` + the three error codes wherever `useErrorMessage` reads codes)
- Test: `apps/web/test/external-auth.test.tsx`

**Interfaces:**
- Consumes: K1 answers `{ handoffUrl } | { authorizationUrl }` (connect) and `{ handoffUrl } | { location }` (link start); S1's `returnScheme`.
- Produces:
  - `connectConnector(orgId, connectorId, returnTo, handoff?: { returnScheme?: string }): Promise<{ authorizationUrl: string } | { handoffUrl: string }>`; `startLink(plugin, returnTo, handoff?)` likewise with `{ location } | { handoffUrl }`.
  - `type ExternalAuthTarget = { kind: "connector"; orgId: string; connectorId: string } | { kind: "identity-link"; plugin: string }`
  - `useExternalAuth(): { open(url: string, target: ExternalAuthTarget): void }` from `ExternalAuthProvider` (in AppFrame).
  - `useBrowserHandoff(): { returnScheme?: string; openExternal(url: string): Promise<void> } | undefined` in `lib/handoff.ts`: undefined without `openExternal@1` (reads `useOpenExternalCapability()`).

Behavior: in `useStartConnect.start` and the identities 「绑定」 mutation, when `useBrowserHandoff()` is defined, request with `handoff: { returnScheme }`; on `{ handoffUrl }` (http(s) only, else the `unknown` toast) call `openExternal(handoffUrl)` inside the click's mutation and `externalAuth.open(handoffUrl, target)`. Otherwise today's `navigateBrowser`. `ExternalAuthDialog` (design `Dialog`): title 「在浏览器中完成授权」, body explaining the browser tab, actions 「复制链接」 (clipboard, success toast), 「完成了」 (invalidate + close), 「取消」 (close). While open: invalidate the target's queries on open and on each window `focus` / `visibilitychange` to visible (connector: the connector detail and list keys; link: the linked accounts key); when the connector's `credential.status === "connected"` (or the plugin appears among the linked identities) close and `toast.success` with the existing `connect.result.connected` (link: the identities page's linked message).

- [ ] **Step 1: Write failing jsdom tests** `external-auth.test.tsx` (fake shell as in `test/native-wiring.test.tsx`, `capabilities: { "openExternal@1": { open: vi.fn(), returnScheme: "capybara" } }`, fake fetch):
  - `connect in a shell asks for a handoff and opens the browser`: click 「连接」 → request body `{ returnTo, handoff: { returnScheme: "capybara" } }`; `open` called with the handoff URL; dialog title visible.
  - `copy link copies the handoff URL`.
  - `focus invalidates the connector queries` (a refetch of the connector after `window.dispatchEvent(new Event("focus"))`).
  - `closes with success when the connector turns connected`.
  - `without the capability the page navigates as today` (`navigateBrowser` called with `authorizationUrl`, no `handoff` in the body).
  - `link in a shell opens the browser` (identities page) and `a location answer navigates in place`.
  - `a non-http handoff URL shows the unknown error and opens nothing`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/external-auth.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** Existing callers of `useStartConnect` (connectors page, `ConnectionActions`, `ConnectCard`) need no change beyond what the hook does.
- [ ] **Step 4: Run** the new test plus `apps/web/test/connect.test.tsx apps/web/test/connectors.test.tsx` and any identities test; `pnpm check:web-ui`, `pnpm check:i18n` — PASS.
- [ ] **Step 5: Commit** `feat(web): finish shell authorizations in the system browser`.

### Task W2: Handoff and done pages (normal)

**Files:**
- Create: `apps/web/src/app/(auth)/handoff/[ticket]/{layout,page,view}.tsx`, `apps/web/src/app/(auth)/handoff/done/{page,view}.tsx`
- Modify: `apps/web/src/lib/handoff.ts` (add the helpers below), `apps/web/messages/{zh,en}.json` (namespace `handoff`), the route table / query keys if a new query is added
- Test: `apps/web/test/handoff-pages.test.tsx`

**Interfaces:**
- Consumes: K2's redeem route and errors; W1's `lib/handoff.ts`; `PlatformMeta.appSchemes`.
- Produces in `lib/handoff.ts`:
  - `redeemHandoff(ticket: string): Promise<{ location: string }>` (POST `/api/v1/auth/handoffs/redeem`).
  - `parseHandoffDone(search: string): { kind: "connector"; orgId: string; connectorId: string } | { kind: "identity-link"; plugin: string } | null` plus `returnTo: string` (through `safeReturnTo`), `scheme?: string`, `result: { kind: "ok" } | { kind: "error"; code: string }` (connector: `connected` / `oauth_error` mapped through `parseConnectResult`; link: `error` absent = ok).
  - `appDeepLink(scheme: string | undefined, appSchemes: readonly string[], origin: string, returnTo: string, resultParams: URLSearchParams): string | null` → `${scheme}://open?url=${encodeURIComponent(origin + returnTo + (?|&) + resultParams)}`, null unless `scheme` is in `appSchemes`.

Behavior:
- `[ticket]/layout.tsx`: signed out (the `maybeMeQuery` through `settledQuery(serverQueryClient(), …)`, as the bind layout reads its query) → `redirect(loginPathFor("/handoff/<ticket>"))` (the login page's parameter is `returnTo`, not the spec's `next`). `page.tsx` exports `metadata = { referrer: "no-referrer" }`.
- `[ticket]/view.tsx` (design `AuthPage`): on mount, once per ticket (a module-level `Set` of redeemed tickets guards the StrictMode double effect), `useAppMutation(redeemHandoff)`; status 「正在打开授权页…」; success → `navigateBrowser(location)` (http(s) or same-site path only); `handoff.invalid` → its message; `handoff.account_mismatch` → the message with `{login}` = login ?? email ?? displayName, and 「换个账号登录」 (sign out, then `/login?returnTo=/handoff/<ticket>` — the ticket is spent, so this only helps the next attempt; the copy also says to go back to the app); other errors → `useErrorMessage`.
- `done/view.tsx` (design `AuthPage`): the result in words with the name (connector: its name from the connector detail query when the session can read it, else generic; link: the source's display name from the auth sources query, else the plugin key); error codes through the existing `connect.result.error.*` / identities link error translations; 「回到 Capybara」 as a link to `appDeepLink(...)` when non-null, tried once automatically on mount (`navigateBrowser`); the note that the tab can be closed; without a link: "go back to the app" text only.

- [ ] **Step 1: Write failing tests** `handoff-pages.test.tsx`:
  - `signed out redirects to login with returnTo` (layout).
  - `redeems once under a remount` (render in `StrictMode`; one POST; navigates to the location).
  - `invalid ticket shows the invalid message`; `account mismatch names the owner and offers another sign-in`.
  - `done page builds the deep link for a listed scheme` (href `capybara://open?url=` + encoded `http://localhost/en/settings/connectors?connected=c1`) and tries it once.
  - `done page refuses unlisted schemes and unsafe returnTo` (`scheme=javascript`, `returnTo=//evil.example` → no button, no navigation).
  - `done page shows the error translation` for `oauth_error=access_denied` and for a link `error=sso.access_denied`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/handoff-pages.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test, `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(web): add the browser handoff and done pages`.

### Task C1: Shells (clients repository, normal)

Work in a clients worktree (`.worktrees/feat-shell-external-authorization`, branch `feat/shell-external-authorization`), following `clients/AGENTS.md`.

**Files:**
- Modify: `apps/desktop/src/main/security.ts` (`hardenProfileContents`), `apps/desktop/src/main/index.ts` (pass `openExternal`), `apps/desktop/src/main/capabilities.ts` (`returnScheme`), `packages/shell` (the `openExternal@1` type, if it has one), `apps/mobile/src/runtime/capabilities/open-external.ts` (`returnScheme`), mobile deep-link routing (where `connect` / `auth` links are routed today) for `{ kind: "open" }`
- Test: `apps/desktop/test/security.test.ts`, `apps/desktop/test/capabilities.test.ts`, `apps/mobile/test/runtime/capabilities.test.ts`, a mobile routing test next to the existing deep-link tests
- Changeset for desktop, mobile and shell.

**Interfaces:**
- Consumes: S1's `returnScheme` contract; `parseDeepLink`'s `{ kind: "open"; url }`.
- Produces: profile windows: `will-navigate` / `will-redirect` to another origin → `preventDefault()` and, for http(s), `openExternal(url)`; same origin → allowed. `openExternal@1` objects carry `returnScheme` = the brand's scheme. Mobile: `<scheme>://open?url=<u>` → the profile whose origin equals `new URL(u).origin` is selected and loads `u`; other origins, non-http(s) and unknown profiles are ignored.

- [ ] **Step 1: Failing tests:** desktop `will-navigate to another origin is prevented and opened externally`, `will-redirect likewise`, `same-origin navigation stays`, `javascript: is prevented and not opened`; capability `openExternal@1 exposes returnScheme`; mobile `open link loads the page on the matching profile` and `open link for an unknown origin is ignored`.
- [ ] **Step 2: Run** `pnpm exec vitest run <those files>` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm verify --fast` — PASS.
- [ ] **Step 5: Commit** `feat(desktop): open off-origin navigations in the system browser` and `feat(mobile): route open deep links` (or one `feat:` commit per app).

---

## Wave plan

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| K1 | — | kernel handoff/, oauth, sso, meta, errors, connectors.ops | high | 1 | alone, most capable |
| S1 | — | plugin-sdk shell type, web `lib/shell.ts`, specs | normal | 1 | batched |
| K2 | K1 | kernel handoff/ service + controller, api.module, exclusions | high | 2 | alone, most capable |
| W1 | K1 (API shape), S1 | web lib/connect, external-auth, identities, AppFrame, messages | normal | 2 | batched |
| W2 | K2 (API shape), W1 (`lib/handoff.ts`, messages) | web handoff pages, messages | normal | 3 | batched |
| C1 | S1 | clients repo | normal | 3 | own review |

Core PR (`feat/shell-external-authorization`): K1, S1, K2, W1, W2. Clients PR: C1, after the core PR is open (it can merge after core is released).

## Manual acceptance (maintainer, desktop app on the local dev stack)

1. Slack connector 「连接」 in the desktop app → the system browser opens `/handoff/…`, signs in if needed, Slack authorizes with the existing browser session, the done page shows 「已连接 Slack」, 「回到 Capybara」 focuses the app on the connectors page with the success toast; without clicking it, focusing the app also flips the connector to connected.
2. 「已绑定账号」 → 绑定 Slack: the same through the SSO link flow.
3. Copy the handoff link from the dialog and open it in another browser profile signed in as another account → 「这个链接属于 …」; the link is spent afterwards.
4. In a plain browser nothing changes (full-page navigation).
