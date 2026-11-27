# Authorizations from a native shell finish in the system browser

Status: approved by the maintainer (2026-11-28), with the recommendations below.

## Intent

Inside the desktop app, clicking 「连接」 on a connector that uses OAuth (Slack, Atlassian, Google…)
loads the provider's authorize page **in the app window**. The window's partition has none of the
person's browser state: no provider session, no password manager, no SSO. The person has to sign in
to the provider again inside the app, and the window stays on a third-party site until the redirect
comes back. Linking a login method on 「已绑定账号」 has the same problem.

Sign-in to Capybara itself already avoids this: the app opens the system browser (desktop spec
§6.5, PKCE and `capybara://auth/callback`), where the person signs in with a password or SSO. This
design gives the two other browser-bound flows the same shape.

## Goals

1. From a native shell (desktop, mobile), connector OAuth and linking a login method open the
   **system browser** and finish there, using the person's existing provider session.
2. The callback URL does not change: it stays `<publicUrl>/api/v1/oauth/callback` (and the SSO
   callback). The kernel exchanges the code server side as today; nothing secret travels to the app.
3. When the browser is done, one click brings the person back to the same page in the app, with the
   usual result message; the app also picks the new state up by itself when it regains focus.
4. The protection the browser binding cookie gives today (only the browser that started a flow can
   finish it) is kept: a link forwarded to someone else cannot make them authorize into the sender's
   connector.
5. In a normal browser nothing changes.

## Non-goals

- Signing in to Capybara from the app: already the system browser flow (desktop spec §6.5, mobile
  app spec §4); unchanged.
- The SSO **sign-in** start (`GET /api/v1/auth/sso/:plugin/start`): only reachable from the login
  page, which a shell never shows.
- Connector setup that needs no OAuth (tokens, API keys): stays an in-app form.
- No change to the OAuth state record, the token exchange, the callback controllers or
  `connector@1` / `identity-source@1`.

## Current state

- `POST /api/v1/orgs/:orgId/connectors/:connectorId/connect` returns `{ authorizationUrl }` and sets
  the binding cookie `cap_oauth` (HttpOnly, SameSite=Lax, path = the callback) on the browser that
  called it. The callback refuses with `session_mismatch` when the cookie is missing or different.
  The web then navigates the whole page there (`useStartConnect` → `navigateBrowser`).
- `POST /api/v1/auth/sso/:plugin/start` with `intent: "link"` (session only) does the same for the
  SSO flow (`cap_sso` binding cookie; the callback also needs the same web session).
- The desktop lets a profile window navigate off its origin (`will-navigate` allows http/https;
  desktop spec §7.1 says this is for connector OAuth). `window.open` to other origins already goes
  to the system browser.
- Both shells expose `openExternal@1`; the web reads it through `useShellCapability`.
- The desktop routes `capybara://open?url=<deployment page>`: focuses the matching profile and
  loads the page. `auth.appRedirectUris` lists every shell's `<scheme>://auth/callback`.

Opening the authorize URL in the system browser as is would fail: the binding cookie lives in the
app's partition, so the callback in the browser answers `session_mismatch`.

## Design

### 1. A handoff ticket instead of the cookie, when the start comes from a shell

Both start routes take an optional body field `handoff: { returnScheme }`:

- `returnScheme` is the shell's URL scheme. The kernel accepts it only when
  `<returnScheme>://auth/callback` is in `auth.appRedirectUris` (exact match), else
  `handoff.scheme_not_allowed` (400).
- With `handoff`, the kernel sets **no** binding cookie and starts no OAuth state. It checks
  everything the normal start checks (connector exists, OAuth configured, `connectors.use`; for a
  link: the source is a login method that is on), then stores a **handoff ticket** and answers
  `{ handoffUrl }`.
- Ticket: `cap_ho_` + 32 random bytes (base64url). Stored in Redis under the SHA-256 of the ticket,
  TTL 10 minutes, with `{ kind: "connector" | "identity-link", accountId, orgId?, connectorId?,
  plugin?, returnTo, returnScheme }`. Single use.
- `handoffUrl` = `<publicUrl>/handoff/<ticket>`, a web page.

### 2. The handoff page signs the person in, then starts the real flow in this browser

`/handoff/<ticket>` (web, `(auth)` group, no app shell around it):

1. No web session in this browser: redirect to `/login?next=/handoff/<ticket>`. The login page works
   as always: password, or SSO with a login method that is on. **This is where the browser gets
   sign-in logic**: the browser does not need to be signed in beforehand.
2. With a session, the page POSTs `/api/v1/auth/handoffs/redeem { ticket }` (session only, CSRF
   header). The kernel takes the ticket atomically (`GETDEL`) and:
   - no ticket (expired, used, unknown) → `handoff.invalid`;
   - the session's account is not the ticket's account → `handoff.account_mismatch`. The page names
     the account the ticket belongs to (its login) and offers 「换个账号登录」 and to go back to the
     app and start again (the ticket is spent either way);
   - otherwise it starts the normal flow **in this browser**: the existing `flow.start` with a fresh
     binding written as the cookie on this response, `returnTo` = `/handoff/done` with the original
     `returnTo` and the scheme kept in the OAuth state record (not in the URL). The answer is
     `{ location }` (the authorize URL); the page navigates there.
   - The connector case re-checks org membership and `connectors.use` for the account at redeem
     time (the entry point sets the org scope from the ticket's `orgId`).
3. The page renders a short status (「正在打开授权页…」) and sends `Referrer-Policy: no-referrer`.

No confirmation card is needed: requiring the ticket's own account in the browser already defeats
forwarding. A forwarded link opened by someone else either finds their session (mismatch) or asks
them to sign in as the sender, which they cannot do.

### 3. Callback unchanged; a done page brings the person back

The callbacks keep redirecting to `returnTo` with `connected=<id>` or `oauth_error=<code>` (and the
SSO link's `?error=` / success parameters). For a handoff flow `returnTo` is `/handoff/done`, which:

- shows the result in words (「已连接 Slack」 / the error's translation), with the connector or
  login method's name;
- shows 「回到 Capybara」, a link to `<scheme>://open?url=<publicUrl><original returnTo>?<result
  params>`, and tries it once automatically on load. The kernel adds the scheme and the original
  `returnTo` to the redirect it already builds, from the state record; the done page accepts a
  scheme only when the public meta lists it (`appSchemes`, derived from `auth.appRedirectUris`), so
  a crafted done URL cannot point the button anywhere else;
- says the browser tab can be closed.

The deep link carries no secret: only a deployment page and the result code. A shell that does not
route `open` links just ignores it, and the app still updates on focus (§4).

### 4. The web in a shell: open the browser, wait, refresh on focus

In `useStartConnect` and in the 「绑定」 action of 「已绑定账号」:

- The same path serves every 「连接」 button: the connectors page, `ConnectionActions` and the
  conversation's `ConnectCard` (what `connectors.connect` shows the person) all use
  `useStartConnect`.
- With `openExternal@1` present (detected only through `window.capybaraShell`, as every shell
  feature), the web asks for a handoff (`returnScheme` from the capability, §5), calls
  `openExternal(handoffUrl)` and opens a dialog (design `Dialog`): 「在浏览器中完成授权」, with
  「复制链接」 (for another browser) and 「完成了」/「取消」.
- While the dialog is open and whenever the window regains focus, the connector (or linked
  accounts) queries are invalidated; when the connector turns connected the dialog closes with the
  success toast. The deep link's navigation reaches the same page with the result parameters, so
  the existing `useConnectResultToast` covers that path.
- Without `openExternal@1` (a browser), the current full-page navigation stays.

### 5. Shells

- **Desktop** (clients): a profile window no longer navigates off its origin. `will-navigate` /
  `will-redirect` to another origin are prevented and handed to `openExternal` (http/https only),
  which is the safe fallback for anything that still navigates (an older web, a link in a guide).
  Desktop spec §7.1's sentence about connector OAuth in the window is replaced by this rule. The
  `open` deep link already exists.
- **Mobile** (clients): `openExternal@1` already opens the system browser; the app routes
  `<scheme>://open?url=` the same way as the desktop (focus the matching profile, load the page on
  its origin only), if it does not yet.
- `openExternal@1` gains an optional read-only `returnScheme` (the shell's own scheme, the one in
  its `<scheme>://auth/callback`). Additive: a shell without it gets a handoff without the deep link
  (the done page then only says to go back to the app; the focus refresh still works). The web's
  copy of the capability type and the clients' `@capybara-hq/shell` change together.

### 6. Errors

| Code | When | zh text (en through i18n) |
|---|---|---|
| `handoff.scheme_not_allowed` | start with a scheme not in `appRedirectUris` | 这个平台还没有允许该应用打开浏览器授权，请联系平台管理员。 |
| `handoff.invalid` | redeem with an unknown, used or expired ticket | 这个授权链接已经失效或用过了。回到应用里重新点「连接」。 |
| `handoff.account_mismatch` | the browser is signed in as another account | 这个链接属于 <login>。请用该账号登录，或回到应用重新发起。 |

Errors from the flow itself (`access_denied`, `token_exchange_failed`…) are shown on the done page
with the existing translations and passed to the app through the deep link.

## Security

- **Forwarded link**: the redeem requires the ticket's account to be signed in in the browser; the
  ticket is single use and lives 10 minutes. This is at least as strong as the binding cookie, which
  only tied the flow to a browser, not to an account.
- **Ticket leakage**: the ticket is in a page path, so it can end up in browser history. It is
  single use, short lived, stored hashed, never logged (the web and kernel request logs redact
  `/handoff/<…>` and the redeem body), and the page sends no referrer.
- **Login CSRF through the handoff page**: redeeming needs a session plus the CSRF header, like the
  existing link start.
- **Deep links** are untrusted input for the shells as today: `open` loads a page only on the
  profile's own origin; the done page builds them only for listed schemes.
- **Scheme allowlist**: only schemes the super admin already allows for app sign-in.

## Rollout

Pre-0.1.0, no compatibility layer. Order: kernel + web (core release), then the shells (clients
release). A new web in an old desktop still works: the desktop already has `openExternal@1`; the
`open` deep link exists. An old web in a new desktop: the in-window navigation becomes an external
open and fails at the callback with `session_mismatch` until the deployment is upgraded; acceptable
before 0.1.0.

## Test plan

- Kernel integration: start with `handoff` → no cookie, `{ handoffUrl }`, ticket in Redis with TTL;
  scheme not allowed → 400; redeem by another account → `handoff.account_mismatch` and the ticket
  is gone; redeem twice → `handoff.invalid`; redeem → binding cookie set and the callback succeeds
  with the fake OAuth server, redirecting to `/handoff/done` with the scheme and original
  `returnTo`; a member who lost `connectors.use` between start and redeem is refused.
- Dual-replica (container): start on replica A, redeem on replica B.
- Web (jsdom): with a fake shell that has `openExternal@1`, 「连接」 calls it with the handoff URL
  and opens the dialog; focus invalidates the queries; without the capability the page navigates as
  today. Handoff page: no session → login redirect with `next`; mismatch and invalid states. Done
  page: the button only for listed schemes.
- Desktop: `will-navigate` to another origin is prevented and opened externally; same-origin stays.
  Mobile: the `open` route.
- Manual: desktop app on the local dev stack, Slack connector and Slack login linking, browser
  already signed in to Slack; then a forwarded handoff link opened in another browser profile.

## AGENTS.md rules touched

- **Mobile and shells**: shell features detected only through `window.capybaraShell` capabilities
  (`openExternal@1`), never the user agent; `openExternal@1` gains an optional `returnScheme`
  (additive, no new capability or version); the desktop rule
  about off-origin navigation in a profile window changes (desktop spec §7.1 amended).
- **Web UI**: the dialog, the handoff and done pages are template + design components; reads via
  `defineQuery`, writes via `useAppMutation`; UI text in zh and en through i18n.
- **Multi-replica discipline**: tickets live in Redis with a TTL and are taken with `GETDEL`; no
  process memory; the redeem sets the org scope at its entry point from the ticket.
- **Kernel**: one new controller route (`@SessionOnly`, `createZodDto`), three error codes
  registered; the start routes' body schemas gain `handoff`.
- **Platform tool**: the redeem route is an exclusion (`human-only`: it needs the person's browser
  session); the start routes' operations keep sending a handoff link card and do not offer
  `handoff` (it is for shells). The parity test follows the shared schemas.
- **Config**: no new key; `appSchemes` in the public meta is derived from `auth.appRedirectUris`.
- **Language**: comments and model-facing text in English.

## Resolved decisions

1. Ticket lifetime: 10 minutes, the same as the OAuth state and the app sign-in attempt
   (maintainer, 2026-11-28).
2. The app's dialog offers 「复制链接」, as app sign-in does (desktop spec §6.1 page 3)
   (maintainer, 2026-11-28).
3. `openExternal@1` gains the optional `returnScheme` field instead of a new capability
   (maintainer, 2026-11-28).
