# Login extensions design: turned on in the admin console, linked accounts, the link page

Status: approved by the maintainer (2026-11-26). Decisions below were taken with the maintainer in
the review of a production conversation (a person asked the agent how to enable Slack sign-in; the
agent could not find the answer through the `Platform` tool and went to read the local source).

## Intent

Third-party sign-in (`identity-source@1`: Google, Lark, Slack today) is configured in two places
that do not meet: the extension's deployment config (OAuth client) is in the admin console and the
`Platform` tool, but whether the login page offers it (`auth.loginSources`) and which tenants are
trusted for email merge (`auth.trustedIdentitySources`) live only in the startup config. Neither a
super admin in the console nor an agent through `Platform` can finish the setup, and the Google
setup guide tells people to change a "platform setting" that does not exist.

The person-facing model is also confusing: a Slack account linked through an IM bind link shows as
「未验证」 on the 「IM 身份」 page even when it works perfectly in IM, or when Slack sign-in is not
offered at all; and signing in with an unlinked Slack account silently creates a new, org-less
account, which then holds that Slack identity so it can no longer be linked to the person's real
account.

## Goals

1. A super admin turns a login extension on, orders the login page and sets its trusted tenants in
   the admin console, on the login extension's own page; an agent can do the same through `Platform`.
2. The startup config holds kernel settings only: `auth.loginSources` and
   `auth.trustedIdentitySources` are removed (the generic `extensionConfig.<name>` override layer
   for an extension's own deployment config stays as it is).
3. Signing in with an external account that is not linked to anyone leads to a **link page**
   (username and password, then link) instead of creating an account; self sign-up becomes an opt-in
   per login extension.
4. One concept for people, **linked accounts** (已绑定账号): one row per external account, with what
   it can do (IM, sign-in) shown as capabilities, and a 绑定 action for each login method that is on.
5. The IM bind link keeps working on every platform (Telegram has no OAuth): it verifies only the
   Capybara account and links for IM only.

## Non-goals

- No change to the identity key (`<plugin>:<tenant>` + platform user id), to `channel@1` /
  `directory@1`, or to how channel inbound resolves a sender.
- No change to email: it stays optional; the username stays the primary sign-in name.
- No OAuth on the IM bind link (decided: one rule for every platform, Telegram included).
- No per-org login methods: sign-in happens before any org is known (`identity-source@1` stays
  deployment-level, "Enabled per org: no").

## Current state (what the code does today)

- `SsoFlow.sources()` / `provider()` (`packages/kernel/src/identity/sso.ts`) offer a plugin only
  when it is in `auth.loginSources` and loaded; the callback URL is
  `<http.publicUrl>/api/v1/auth/sso/<plugin>/callback`.
- `ExternalIdentities.resolve` (`external.ts`), on the sign-in path: a linked row → that account (a
  `bind` row only when the start and the callback carried the same signed-in account, then upgraded
  to `sso`, Ruling A18); an unlinked identity → merge by verified email when the full key is in
  `auth.trustedIdentitySources`, else **create an account**.
- A signed-in person who starts sign-in for an identity nobody has linked gets a **new account** and
  their session switches to it (resolve ignores the session for unlinked identities).
- `IdentityBinding` (`binding.ts`): an IM bind link (`cap_bind_…`, Redis, 15 min, single use) asks
  for a web session and links with `linked_via = bind`.
- `/account/identities` lists rows with a 「未验证」 badge on `bind` rows and a 「验证」 row action
  only when the plugin is in `auth.loginSources`.

## Design

### 1. Settings: one deployment setting, kernel-owned

The login settings are a `deployment_settings` row, key `loginSources` (the table exists, has no
`org_id`, so no RLS policy and no migration are needed):

```ts
type LoginSourceSettings = {
  plugin: string;          // an extension providing identity-source@1
  enabled: boolean;        // offered on the login page
  signUp: "link" | "create"; // an unlinked external account: link page (default) or self sign-up
  trustedTenants: string[];  // tenant ids; the kernel builds keys `${plugin}:${tenant}`
}[]; // array order = login page order
```

- Read from PG at each use (login page, start, callback, resolve, directory sync's
  `email_verified`), never cached in process (multi-replica; sign-in is rare enough that one indexed
  read per request costs nothing). Written in a `@Transactional()` service method with an audit
  row (`login_sources.updated`, before/after).
- An entry whose extension is not loaded or no longer provides `identity-source@1` is kept but not
  offered (same as an unloaded plugin in `loginSources` today); uninstalling the extension does not
  delete its entry, so reinstalling restores it. The overview shows such entries as unavailable.
- `trustedTenants` is checked when written: each id matches the extension's declared tenant
  `pattern` (§2) and is not in its `neverTrusted` list; at most 50 per source (today's bound).
- The startup keys `auth.loginSources` and `auth.trustedIdentitySources` are deleted from
  `KernelConfigSchema` with their hot listeners. `auth` is a `strictObject`, so a deployment that
  still sets them fails at startup naming the key; the release note says to remove them and set
  the methods in the console. No conversion (pre-0.1.0, and production sets neither).
- Trust keeps its meaning (Rulings A9 / A19): only on third-party sign-in, a verified email equal
  to exactly one account's verified email links to that account; an account created through a
  trusted tenant counts as email-verified.

### 2. `identity-source@1`: the plugin declares its tenant

The admin page needs to say what a tenant is for each platform. `IdentitySource` gains an optional
field (SDK minor change: `pnpm gen:sdk-api`, changeset bumping `@capybara-hq/plugin-sdk`,
`pnpm gen:agent-docs` for the extension point topic):

```ts
tenant?: {
  label: { zh: string; en: string };        // "Slack 工作区 ID" / "Workspace ID"
  help?: { zh: string; en: string };        // where to find it
  pattern?: string;                          // ^T[A-Z0-9]+$
  placeholder?: string;                      // T0123ABCD
  neverTrusted?: string[];                   // tenants that may never be trusted: google "consumer"
};
```

Without `tenant`, the page shows a plain "租户 ID" field. Official plugins (capybara-hq/plugins)
declare it: Slack (team id, `^T[A-Z0-9]+$`), Lark (`tenant_key`), Google (the Workspace primary
domain, `neverTrusted: ["consumer"]`, matching the warning in its guide today).

### 3. Admin console and `Platform`

Routes (super admin, `admin.controller` family, DTOs from `login-sources.schemas.ts`):

| Route | Purpose |
|---|---|
| `GET /api/v1/admin/login-sources` | every loaded `identity-source@1` extension and every stored entry: plugin, label, tenant declaration, `enabled`, `signUp`, `trustedTenants`, order, `available` (loaded and providing the point), `needsConfig` (deployment config invalid), the callback URL |
| `PUT /api/v1/admin/login-sources/:plugin` | set `enabled`, `signUp`, `trustedTenants` (partial); enabling appends to the order |
| `PUT /api/v1/admin/login-sources/order` | the whole order as a list of plugins |

Enabling a source whose deployment config is invalid (`needsConfig`) is refused
(`login_sources.needs_config`, next step: fill in the config, the extension's setup guide), so the
login page never offers a button that fails.

Web:
- **The login extension's page** (`/admin/extensions/<name>`) gets a 「登录」 section when the
  extension provides `identity-source@1`: switch 「在登录页显示」, 「未绑定的账号」 (单选: 去绑定页
  (推荐) / 自动注册新账号), 「可信租户」 (a list field using the declared label, pattern and help, with
  the existing trust warning), and the callback URL to copy. Design components only (a `FormSection`
  on the existing page template).
- **Order**: the platform settings page gets a 「登录方式」 section listing the login extensions on
  the platform (enabled first, in login page order, each linking to its extension page); the
  enabled ones are reordered by drag (with keyboard move up / down for accessibility), saved through
  the order route. A list of all login methods needs one place; everything about one method stays
  on its page (maintainer decision 2026-11-26).

`Platform` operations, built from the route schemas (`check:platform-ops`, parity test):
`login-sources.list`, `login-sources.update`, `login-sources.reorder`. They carry no secret (the
OAuth client secret stays in `extensions.platform-set-config` with its secure input). The
`extensions.platform-config` result of an identity-source extension says where its login settings
are (`next`: `login-sources.update`), so an agent following the config finds the switch.

Setup guides: the Google guide's step 5 and the new Slack / Lark sign-in guides (being added in
capybara-hq/plugins) say "turn it on in the 「登录」 section of this page, or ask the agent"; the
trusted-tenant step points at the same section.

### 4. Sign-in flow

`SsoFlow.start(plugin, returnTo, binding, session, intent)` with `intent`:

- `signin` (default, the login page): as today.
- `link` (the linked accounts page, §5): requires a web session at start; the state records it; at
  the callback the request must carry **the same** session, otherwise `sso.session_mismatch`. A
  link-intent callback never creates an account and never switches the session.

The callback, after the existing checks (state single use, browser binding, plugin verification,
source key `${plugin}:${tenantId}`), decides on the identity row:

| Row | `intent: link` (signed in as A) | `intent: signin` |
|---|---|---|
| linked to A (`sso` / `directory` / legacy) | refresh, back to the page | sign in as A |
| linked to A as `bind` | upgrade to `sso` (audit `identity.verified`) | **link page** (password of A upgrades it) |
| linked to another account B | `identity.taken` | sign in as B (`sso` / `directory`); a `bind` row of B → link page |
| none, trusted-email merge applies | link to A (A's session wins over the email) | link to the merge target, sign in |
| none | link to A as `sso` (audit `identity.linked`, via `oauth`) | `signUp: link` → **link page**; `signUp: create` → create account (today's behaviour) |

Directory rows keep signing in directly (unchanged): directory sync made the account for that
identity.

### 5. The link page

When the callback chooses the link page:

1. The kernel stores a pending link in Redis: `capk:sso-link:<sha256(ticket)>`, 10 minutes,
   `{ plugin, identity (normalized), returnTo, binding hash, existingRow? }`; the ticket is
   `cap_link_<32 bytes base64url>` (the `cap_` prefix keeps it masked in logs). It keeps the
   `cap_sso` browser binding cookie (the callback does not clear it on this branch) and redirects to
   `/login/link?ticket=…`.
2. `GET /api/v1/auth/sso/link?ticket=…` (public, needs the matching `cap_sso` cookie, which its path
   covers) returns what the page shows: platform label, tenant, display name, avatar, and whether
   the identity is already linked (bind) to an account (never which one).
3. The page (`AuthPage` template) says: 「这个 Slack 账号（朝华 · 工作区 T0BB…）还没有可登录的
   Capybara 账号。用你的用户名和密码登录，完成绑定。」 with username / password, a 「取消」 back to
   `/login`, and 「没有账号？请联系管理员。」
4. `POST /api/v1/auth/sso/link` `{ ticket, login, password }` (public, CSRF header + Origin like
   `/auth/login`, the `cap_sso` cookie): verifies the password through the same service as
   `/auth/login` (the same per-login and per-(login, IP) throttles of R25, lockout and audit), then
   in one transaction under the identity lock: no row → link to the account as `sso`; a `bind` row
   of the same account → upgrade to `sso`; a row of another account → `identity.taken` ("this Slack
   account is linked to another Capybara account; sign in there and unlink it first"). Disabled
   account → `auth.account_disabled`. Success: the ticket is deleted, a session is created exactly
   as a password sign-in (a must-change-password account goes to change-password next), audit
   `identity.linked` with `via: "link_page"`.
5. The ticket is single use on success and burned after 5 wrong passwords
   (`sso.link_expired` afterwards); an expired or unknown ticket → back to `/login?error=sso.link_expired`.

Both routes are `Platform` exclusions (`human-only`: a person's own sign-in with a password).

### 6. Linked accounts page (`/account/identities`)

Renamed 「已绑定账号」 / "Linked accounts" (route unchanged). One row per identity:

| Column | Content |
|---|---|
| 账号 | display name, avatar |
| 平台 / 租户 | plugin label, tenant id |
| IM | 可用 when the plugin provides `channel@1`, else — |
| 登录 | 不支持 (the plugin provides no `identity-source@1`) · 未开启 (not enabled on the platform) · 启用登录 (a `bind` row: the action starts `intent: link`, which upgrades it) · 可登录 |

The 「未验证」 badge goes. Above the table, one 「绑定 <平台>」 button per enabled login method the
account has no identity for (starts `intent: link`). Unlink keeps today's rule (an account without a
password cannot unlink its last sign-in identity, `identity.last_login_method`). The empty state
says how rows appear: messaging the bot, a 绑定 button, or directory sync.

`GET /api/v1/me/identities` gains per row `channel: boolean` and `login: "unsupported" | "off" |
"needs_link" | "on"` (computed from the registry and the setting), so the page has no logic of its
own; the web type follows (`check:web-api-parity`).

### 7. IM bind link (unchanged rule, clearer card)

The bind link still verifies only the Capybara account, on every platform, and links with
`linked_via = bind` (IM only). The confirmation card shows the platform, tenant, display name and
avatar, and adds: 「只绑定你本人的账号。如果这个链接是别人发给你的，不要绑定。」 The forwarded-link
risk (an attacker's IM account linked to a victim who clicks the attacker's link) is accepted; it is
bounded because a `bind` row never signs anyone in.

## Security

- **Forwarded IM bind link**: accepted risk, bounded to IM (above); the link page and the 绑定
  action both need OAuth proof of the external account plus the Capybara account, so neither can be
  driven by a forwarded link.
- **Login CSRF / session swap**: state single use, browser binding cookie, PKCE unchanged; `intent:
  link` requires the same session at start and callback; the link page needs the ticket, the
  binding cookie and the CSRF header. A link-intent callback never signs anyone in as someone else.
- **Password guessing through the link page**: the same throttles and lockout as `/auth/login`,
  plus 5 attempts per ticket; generic error text.
- **Tenant trust**: super admin only (console or an approved `Platform` call); validated against
  the plugin's pattern and `neverTrusted`; the warning text stays next to the field.
- **Self sign-up**: off by default; when on, behaviour as today (an org-less account; org creation
  still follows `orgCreation`).
- **Enumeration**: the link page reveals only that this external account (which the person just
  proved they control) is or is not linked, never to whom.

## Rollout

One core PR (kernel, SDK, web, docs, tests) and one plugins PR (tenant declarations, guide text),
released together. Release note: remove `CAPYBARA_AUTH__LOGIN_SOURCES` /
`CAPYBARA_AUTH__TRUSTED_IDENTITY_SOURCES` (startup fails while they are set) and turn the methods on
under 平台 → 扩展 → <extension> → 登录. Production sets neither today.

## Test plan

- Unit: settings parsing and validation (pattern, `neverTrusted`, bounds); the callback decision
  table of §4 (every cell); link ticket lifecycle (single use, attempts, expiry, binding mismatch).
- Integration (kernel, one app per file): admin routes and audit; login page sources follow the
  setting at once; `intent: link` with and without the same session; the link page end to end with
  `startFakeOAuthServer({ oidc })` + `fake-im`'s identity source (link, upgrade a `bind` row,
  `identity.taken`, wrong password throttling, disabled account, must-change-password);
  `signUp: create` keeps today's behaviour; trusted merge reads the setting; `/me/identities`
  capabilities.
- Dual-replica: start on one replica, callback and link POST on the other (Redis-only state).
- Web: linked accounts page states (jsdom), link page, the 登录 section and the order section;
  e2e `global-setup.ts` seeds the setting through the admin route instead of `auth.loginSources`.
- Checks: `check:platform-ops` and the parity test for the three operations and two exclusions;
  `check:sdk-api` / `check:api-changeset`; `check:agent-docs`; `check:i18n` (zh copy uses 平台 /
  超级管理员).

## AGENTS.md rules touched

- **Config**: removes two `auth.*` startup keys; the startup config keeps kernel settings only.
  Extension deployment config (env > file / Nacos > PG > default) is unchanged. `docs/config.md` is
  regenerated (`adding-config`).
- **Multi-replica discipline**: the settings live in PG and are read per use (no in-process cache);
  link tickets and SSO state live in Redis with TTLs; writes are `@Transactional()` with audit; no
  timers.
- **Migrations**: none; `deployment_settings` has no `org_id`, so no RLS policy is involved.
- **Kernel**: new routes follow the Nest conventions (`@Injectable` service, `@Inject`,
  `createZodDto`, `@SuperAdmin`), checked by `check:kernel-conventions`.
- **Platform tool**: three new operations mirror the admin routes from their schemas; the two link
  page routes are exclusions (`human-only`, a person's password); no secret becomes a param.
- **Extensions / channels, login, directory**: `identity-source@1` stays deployment-level and not
  per org; its enabling moves from `auth.loginSources` to the kernel setting. The writing-channels
  skills (core and plugins) and `docs/guide/slack-and-lark.md` are updated.
- **Public API reports**: `IdentitySource.tenant` is an SDK API change: `pnpm gen:sdk-api` plus a
  changeset bumping `@capybara-hq/plugin-sdk`.
- **Web UI**: the new sections and the link page are template + design components, reads through
  `defineQuery`, writes through `useAppMutation`; no box in a box.
- **Language**: model-facing text (operation descriptions, `next` steps) in English; UI text through
  i18n in zh and en, with 平台 / 超级管理员 in zh.

## Resolved decisions

1. Startup config keeps kernel settings only; the two `auth.*` keys are removed, not made read-only.
2. Login settings are kernel-owned, edited on the login extension's page; tenant meaning is declared
   by the plugin.
3. An unlinked external account goes to the link page by default; self sign-up is opt-in per source.
4. Email stays optional; trusted-email merge stays as an optional shortcut per source.
5. One "linked accounts" concept with IM / 登录 capabilities; 未验证 is removed.
6. The IM bind link verifies only the Capybara account for every platform and links for IM only;
   the forwarded-link risk is accepted.
7. Cross-source order lives in the platform settings page's 「登录方式」 list, reordered by drag;
   each method's own settings stay on its extension page.
