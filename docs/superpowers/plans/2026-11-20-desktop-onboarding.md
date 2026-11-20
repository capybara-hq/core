# Desktop onboarding implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development with the
> project skill `wave-planned-subagent-development`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** the desktop app owns its pre-sign-in and signed-out pages in a small fixed window, keeps
errors after sign-in in the main window, signs out through the web or a new 「平台」 menu, draws
every dialog itself (unforgeable ones in a separate shell-owned window), and shares theme and
language with the web.

**Spec:** `docs/superpowers/specs/2026-11-07-desktop-client-design.md` §6.1, §6.2
(`appRedirectUris`), §6.3, §6.5 to §6.10, §7.4, §8, §12, §13 (amended 2026-11-20, core #470), and
layout spec §9.2 (`chrome@1` row) and §9.4. The spec wins over this plan; the mockups in
`capybara-hq/clients` `apps/desktop/design/onboarding/` win for layout and copy.

**Repositories:** `capybara-hq/clients` (almost everything) and `capybara-hq/core` (task C1).
Clients rules: no `@capybara-hq/design`, no Electron imports in `packages/shell`, main-process
modules take Electron objects as parameters, tests never touch Keychain / login items / launchd,
zh copy uses 平台 / 智能体 / 设备 / 本机.

**Coordination:** the mobile app plan (`2026-11-20-mobile-app.md`) runs in parallel and touches
`packages/shell` (`meta.ts`, `i18n/*.json`, sign-in guard, installer lifts), the desktop preload
`shell-environment.ts`, `request-guard.ts`, and in core `packages/plugin-sdk` shell capability
types and `apps/web/src/lib/shell.ts`. Never touch `apps/mobile`. Before each wave, rebase the
wave's base on `origin/main`; on a conflict in a shared file keep both sides' additions. The
`chrome@1` change is additive only (`tokens?`, `singleScheme?`).

## Interfaces fixed by this plan

```ts
// packages/shell/src/meta.ts (K2)
export type DiscoveryError =
  | "unreachable" | "not_capybara" | "too_old" | "not_https" | "cert_invalid";
export interface Meta { /* + */ appRedirectUris?: string[] }   // absent on older kernels
/** Sign-in-stage verdict before opening the browser: null = go. */
export function appSignInBlocked(meta: Meta, redirectUri: string): "not_allowed" | null;

// apps/desktop/src/main/sign-in.ts (K3)
export type SignInFailure =
  | "timeout" | "cancelled" | "not_allowed" | "account_unusable" | "link_invalid";
export type SignInOutcome =
  | { ok: true; account: { name: string; login: string } }
  | { ok: false; reason: SignInFailure };
interface SignIn {
  /** Starts (or restarts) the attempt for `profile`; resolves once, with the outcome. */
  begin(profile: Profile): { url: string; outcome: Promise<SignInOutcome> };
  /** The pending attempt's authorize URL (reopen / copy), undefined when none. */
  pendingUrl(profileId: string): string | undefined;
  /** Ends the pending attempt of the profile as `cancelled`. */
  cancel(profileId: string): void;
  handleCallback(cb: AuthCallback): Promise<void>;
  /** A callback whose `state` is unknown but whose `iss` is `origin` (link_invalid, spec §6.6). */
  onStaleCallback(listener: (origin: string) => void): () => void;
  capability: { start(ctx: CallContext): Promise<"signedIn" | "cancelled"> };  // signIn@1, kept
}

// apps/desktop/src/main/profiles.ts (K4)
export interface Profile {
  id: string; base: string; origin: string; name: string; iconHash?: string;
  signedIn: boolean;                              // default false when reading an older file
  account?: { name: string; login: string };
  bounds?: { x: number; y: number; width: number; height: number };
  appearance?: Appearance;                        // K8 writes it
}
interface ProfileStore { /* + */ update(id: string, patch: Partial<Omit<Profile, "id" | "base" | "origin">>): Profile | undefined }

// apps/desktop/src/main/appearance.ts (K1 creates, K8 completes)
export interface Tokens { bg: string; panel: string; ink: string; muted: string; line: string; accent: string; onAccent: string }
export interface Appearance { scheme: "light" | "dark"; tokens?: Tokens; singleScheme?: boolean }
export const BUILTIN_TOKENS: Record<"light" | "dark", Tokens>;  // the E 终端 values
export function isColor(v: unknown): v is string;               // #rgb #rrggbb, rgb()/rgba()

// apps/desktop/src/main/shell-dialog.ts (K6): same contract as dialog.showMessageBox, extended
export interface ShellDialogOptions {
  title: string; detail: string; buttons: string[]; defaultId: number; cancelId: number;
  /** Index of the confirming button and how it looks. */
  confirmId?: number; tone?: "primary" | "danger";
  platform?: { name: string; host: string; iconUrl?: string };
}
export type ShowShellDialog = (parent: unknown, o: ShellDialogOptions) => Promise<{ response: number }>;

// apps/desktop/src/main/sign-out.ts (K7)
interface SignOut {
  /** The logout POST of the profile's partition completed with 2xx (webRequest). */
  noteLoggedOut(profileId: string): void;
  /** True once after noteLoggedOut, within 30 s: the next /login is the end of a sign-out. */
  takeLoggedOut(profileId: string): boolean;
  /** Marks signed out, closes the main windows, shows the signed-out small window. */
  complete(profileId: string): Promise<void>;
  /** The 「平台」 menu entry: shell dialog, then logout POST, then complete. */
  confirmAndSignOut(profileId: string): Promise<void>;
}
```

Local page bridge (preload `local.cjs`, K1): `window.capybaraLocal = { state(): Promise<PageState>;
onState(cb): () => void; act(action: string, args?: object): Promise<unknown> }`. The main process
accepts `act` only from a webContents it registered as a local page (small window, overlay or
dialog) and validates each action against the page's kind. `PageState` carries `page`, `locale`,
`appearance` (scheme, tokens, singleScheme), `platform` (name, host, iconUrl), `controls` rect,
`version` and the page's own fields.

## Wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| C1 core: meta `appRedirectUris`, `auth.account_disabled`, chrome@1 tokens | — | core kernel meta + app-auth, design `shell-environment.tsx`, `app-shell.tsx`, apps/web AppFrame + `lib/shell.ts`, plugin-sdk shell types | normal | 1 | batched (core) |
| K0 mockups into clients | — | `apps/desktop/design/onboarding/**` | — | 1 | none (coordinator) |
| K1 local page kit, i18n, appearance store | — | `apps/desktop/src/local/**`, `scripts/build.ts`, `src/main/app-protocol.ts`, `src/preload/local.ts`, `src/main/local-pages.ts`, `src/main/appearance.ts`, `packages/shell/src/i18n/*` | normal | 1 | batched |
| K2 shell discovery verdicts | — | `packages/shell/src/meta.ts`, `address.ts`, tests | normal | 1 | batched |
| K3 sign-in outcomes | — | `apps/desktop/src/main/sign-in.ts`, test | high | 1 | alone, opus |
| K4 profile fields, main window bounds | — | `src/main/profiles.ts`, `src/main/window-bounds.ts`, tests | normal | 1 | batched |
| K5 small window + onboarding host | K1, K2, K3, K4 | `src/main/windows.ts`, `src/main/onboarding.ts`, `src/local/pages/onboarding.*`, `src/main/index.ts`, delete `address-page/`, `preload/address*`, `main/address.ts` | normal | 2 | batched |
| K6 shell dialogs | K1 | `src/main/shell-dialog.ts`, `src/local/pages/dialog.*`, `src/main/device/dialogs.ts`, `src/main/remove-profile.ts`, `src/main/index.ts` (the `showMessageBox` swap only) | high | 2 | alone, opus |
| K7 sign-out and 「平台」 menu | K5, K6 | `src/main/sign-out.ts`, `src/main/app-menu.ts`, signed-out page in `src/local/pages/onboarding.*`, `index.ts` | normal | 3 | batched |
| K8 theme and language | K1, K5 | `src/main/appearance.ts`, `src/main/capabilities.ts` (chrome), `src/main/preferences.ts`, cookie read/write | high | 3 | alone, opus |
| K9 expired and unreachable pages | K5, K7 | `src/main/session-watch.ts`, `src/main/overlay.ts`, `src/local/pages/main-error.*`, `windows.ts`, `index.ts` | normal | 4 | batched |
| K10 e2e | all | `apps/desktop/e2e/**`, `packages/shell/test/fixtures/fake-deployment.ts` | normal | 5 | batched |

Waves land on `main` of each repository as one PR per wave (clients) so the mobile work rebases
on small steps. K5 and K6 both edit `index.ts` in disjoint regions: separate worktrees, merged in
task order by the coordinator. Final whole-branch review on opus after wave 5, then the unsigned
dmg (`pnpm --filter @capybara-hq/desktop dist --mac --publish never`).

## Task C1 (core): meta, account_disabled, chrome@1 tokens

**Files:** `packages/kernel/src/http/meta.controller.ts` (+ its test), `packages/kernel/src/identity/app-auth.ts`
(+ test), `packages/design/src/shell/shell-environment.tsx`, `packages/design/src/shell/app-shell.tsx`
(prop `singleScheme?: boolean`), `apps/web/src/components/shell/AppFrame.tsx` (passes the resolved
theme's `singleScheme !== null`), `packages/plugin-sdk/src/shell-*.ts` + `api/plugin-sdk.api.md`,
`apps/web/src/lib/shell.ts` mirror, changesets (kernel, design, plugin-sdk, web as published).

- [ ] Meta: `appRedirectUris: string[]` = `config.auth.appRedirectUris` when `http.publicUrl` is
  set, else `[]`; schema and test updated (through the web proxy test where meta is tested).
- [ ] App token exchange: an account whose status is not `active` → `ApiError("auth.account_disabled", …)`
  (403) instead of `app_auth.code_invalid`; integration test.
- [ ] Design: `appearance()` also reads the computed `--cb-bg`, `--cb-panel`, `--cb-ink`,
  `--cb-muted`, `--cb-line`, `--cb-accent`, `--cb-on-accent`; sends `tokens` only when all seven
  are colors (hex or rgb/rgba, the existing `COLOR` rule; `color-mix` and others are dropped:
  then no `tokens`), and `singleScheme: true` when the AppShell prop says so. The dedupe key
  includes tokens and singleScheme. jsdom test with a fake shell.
- [ ] SDK: `ChromeCapabilityV1.setAppearance` input gains `tokens?: ShellChromeTokens` and
  `singleScheme?: boolean`. If the mobile plan's Task 2 has landed, extend its type; if not, add
  `ChromeCapabilityV1` with `setAppearance` only (mobile adds `ready?` additively), plus
  `SHELL_CAPABILITY_KEYS.chrome` only if absent. `pnpm gen:sdk-api`, changeset.
- [ ] `pnpm verify` green; PR `Closes #469` (the line issue stays referenced by later PRs as
  `Refs #469`).

## Task K0: mockups into clients (coordinator)

Copy the approved mockups (`*.dc.html`, `canvas.json`) into `apps/desktop/design/onboarding/`
with a short README stating they are the visual reference (spec §header). Excluded from biome.

## Task K1: local page kit, i18n catalog, appearance store

**Files:** create `apps/desktop/src/local/base.css`, `src/local/kit.ts` (DOM helpers: preference
bar, footer, platform icon, buttons, alert, field), `src/local/runtime.ts` (reads `capybaraLocal`,
applies `data-theme` and token custom properties, translates `data-i18n`), `src/preload/local.ts`,
`src/main/local-pages.ts` (registry of local webContents → kind; `act` dispatch; `state` push),
`src/main/appearance.ts` (types, `BUILTIN_TOKENS`, `isColor`, `resolveAppearance(osDark,
profileAppearance?, cookieTheme?)`); modify `scripts/build.ts` (bundle `local/pages/*.ts` for the
browser, copy html/css), `src/main/app-protocol.ts` (serve `local/` under `app://local/…`; the old
address host goes in K5), `packages/shell/src/i18n/{zh,en}.json` (**every** string of this plan,
from the mockups and spec §6.1, §6.6, §6.8, §6.9, §7.4; keys under `onboarding.*`, `mainError.*`,
`signOut.*`, `dialog.*`, `menu.platform.*`, `prefs.*`).

- [ ] CSS: the E 终端 values as `--cb-*` custom properties for `[data-theme=dark]` and
  `[data-theme=light]`, overridden by inline token properties when present; fonts: `"Sarasa Mono
  SC", "JetBrains Mono", ui-monospace` for mono, system sans for text; the 480×600 layout grid
  (content centered, 56 px side padding, 44 px drag band `-webkit-app-region: drag` with
  `no-drag` on controls, bottom-right preference bar, bottom-centered footer); the blinking block
  cursor; focus rings; reduced motion respected.
- [ ] Preference bar: language menu (中文 / English) and the light / dark segmented toggle,
  hidden under `singleScheme`; actions `prefs.setLocale`, `prefs.setTheme` (K8 implements them in
  main; K1 dispatches them to a provided handler).
- [ ] Strict CSP on every local page (`default-src 'none'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:`); platform icons reach pages as `data:` URLs fetched by
  main (reuse the Dock icon fetch rules: PNG ≤ 1 MB), never a remote URL.
- [ ] Tests: `local-pages` registry refuses `act` from an unregistered sender and an action not
  allowed for the kind; `appearance` resolution table; `isColor`; i18n key sync (`pnpm check:i18n`).

## Task K2: discovery verdicts in packages/shell

**Files:** `packages/shell/src/meta.ts`, `src/address.ts`, tests.

- [ ] `Meta.appRedirectUris?` parsed (array of strings, else undefined).
- [ ] `discover(input, fetch)` returns `{ ok: true, base, meta }` or `{ ok: false, error: DiscoveryError }`:
  `not_https` from normalization (loopback exempt); `cert_invalid` when the fetch error message or
  cause carries `ERR_CERT_` / `CERT_` (Electron `net.fetch` errors); `unreachable` for other
  network errors and a 10 s timeout; `not_capybara` for non-2xx, non-JSON or wrong shape;
  `too_old` when `features.appSignIn` is absent.
- [ ] `appSignInBlocked(meta, redirectUri)`: `not_allowed` when `appSignIn` is false or
  `appRedirectUris` is present and lacks `redirectUri`.
- [ ] Tests against `test/fixtures/fake-deployment.ts` (extend it with switches for each case).

## Task K3: sign-in outcomes (high)

**Files:** `apps/desktop/src/main/sign-in.ts`, `apps/desktop/test/sign-in.test.ts`.

- [ ] Implement the `SignIn` interface above, keeping every existing guarantee (PKCE, `state` one
  use, `iss` check, partition fetch, `redirect: "error"`, no token stored, timeout of the
  exchange).
- [ ] Outcome mapping: TTL expiry → `timeout`; callback `access_denied` or `cancel()` →
  `cancelled`; exchange `app_auth.unavailable` / `app_auth.redirect_uri_invalid` → `not_allowed`;
  `auth.account_disabled` → `account_unusable`; `app_auth.code_invalid`, any other failure, a
  refused callback verdict → `link_invalid`. Success returns the account's display name and login
  (or email) from the token response, validated as short strings; nothing else is kept.
- [ ] `onStaleCallback`: a callback with an unknown `state` whose `iss` parses as an http(s)
  origin calls listeners with that origin (the onboarding host decides whether it waits for it).
- [ ] `capability.start` (signIn@1) keeps its old result type: `signedIn` or `cancelled`, a
  failure rejects `{ code: "failed" }`; on success it still calls `onSignedIn(profile)`.
- [ ] Tests for every mapping, replay, a second `begin` cancelling the first, `pendingUrl`.

## Task K4: profile fields and main window bounds

**Files:** `apps/desktop/src/main/profiles.ts`, create `src/main/window-bounds.ts`, tests.

- [ ] Profile fields of the interface above; reading a version-1 file defaults `signedIn` to
  `true` for existing profiles (they were signed in through the old flow or will hit the expired
  page) and validates every optional field (drop what is malformed). `update(id, patch)` with an
  atomic write.
- [ ] `window-bounds.ts`: `initialBounds(saved, displays)`: 1280×800 centered on the primary
  display's work area when none is saved or the saved rectangle intersects no display's work area
  by at least 100×100; `trackBounds(win, save)` saves on `resize` / `move` debounced (300 ms,
  injected scheduler) and on `close`.
- [ ] Tests with fake displays.

## Task K5: the small window and the onboarding host

**Files:** `apps/desktop/src/main/windows.ts`, create `src/main/onboarding.ts`,
`src/local/pages/onboarding.{html,ts}`; modify `src/main/index.ts`; delete
`src/address-page/`, `src/preload/address*.ts`, `src/main/address.ts` and their tests
(their deep-link prefill moves to the host).

- [ ] Small window: 480×600, `resizable: false`, `maximizable: false`, `fullscreenable: false`,
  `titleBarStyle: "hiddenInset"` with the traffic lights at the main window's position on macOS;
  Windows/Linux `titleBarStyle: "hidden"` + `titleBarOverlay` (height 32, colors from the
  appearance); background from the appearance; the local preload; one small window at a time.
- [ ] Main window: K4's bounds, `minWidth 480`, `minHeight 400`, opens on `profile.base + "/"`
  after sign-in; the rest unchanged.
- [ ] Onboarding host (state machine, pure, tested): `connect` (prefill, error) → `found`
  (provisional profile with a new id and partition, meta, icon) → `waiting` (K3 `begin`; reopen =
  `openExternal(pendingUrl)`, copy = clipboard write of `pendingUrl`, cancel = `cancel()` → found)
  → on `ok`: `profiles.add` + `update({ signedIn: true, account })`, close the small window,
  open the main window on `/`; on failure: `found` with the sign-in error (copy §6.6). Before
  `begin`, `appSignInBlocked` → the `not_allowed` error without opening the browser. A stale
  callback for the provisional profile's origin while `waiting` → `link_invalid`. Closing the small
  window abandons the attempt and clears the provisional partition.
- [ ] Start-up (spec §6.3): last profile `signedIn` → main window; not signed in → small window
  signed-out page (K7 renders it; until then the `found` page of that profile); none → `connect`.
  Deep link `capybara://connect` → small window `connect` prefilled.
- [ ] Pages follow the boards `Main`, `Found`, `Waiting`, `Errors`, `ErrorsSignIn` exactly (sizes,
  spacing, copy); the footer `Capybara 桌面端 <version>` on connect/found, the host on waiting.
- [ ] Unit tests for the state machine and the window options; delete the address tests.

## Task K6: shell dialogs (high)

**Files:** create `apps/desktop/src/main/shell-dialog.ts`, `src/local/pages/dialog.{html,ts}`;
modify `src/main/device/dialogs.ts` and `src/main/remove-profile.ts` (take `ShowShellDialog`,
pass `platform`, `confirmId`, `tone`), `src/main/index.ts` (replace the `showMessageBox` wiring
and the `dialog` import), tests.

- [ ] Window: frameless, `parent` + `modal: true` when the parent lives (macOS sheet), else
  standalone, centered, `alwaysOnTop`; width 400, height from the page's reported content height
  clamped to 160…560; `resizable: false`, `minimizable: false`, `fullscreenable: false`; local
  partition and preload; `show` only at `ready-to-show`.
- [ ] Content only from the main process; the answer only through `act("dialog.answer", { index })`
  from that dialog's webContents (registered in K1's registry as kind `dialog`), index validated;
  the first answer wins; window close, Esc, parent close → `cancelId`; Enter activates the focused
  button and focus starts on cancel; the confirming button ignores activation for 500 ms after
  show (`dialog.answer` with `confirmId` earlier is dropped in main, not only in the page).
- [ ] One dialog per profile at a time stays the job of `createConfirmGate` (unchanged);
  `shell-dialog` additionally refuses a second dialog for the same parent while one is open
  (resolves `cancelId`).
- [ ] No `dialog.showMessageBox` left in `src/` (a unit test greps the sources).
- [ ] Tests with fake windows: answer, cancel paths, early-click drop, foreign sender refused.

## Task K7: sign-out and the 「平台」 menu

**Files:** create `apps/desktop/src/main/sign-out.ts`; modify `src/main/app-menu.ts`,
`src/local/pages/onboarding.*` (signed-out page), `src/main/onboarding.ts` (signed-out state),
`src/main/index.ts`, tests.

- [ ] `noteLoggedOut` from a `webRequest.onCompleted` listener on each profile partition for
  `POST <base>/api/v1/auth/logout` with status 2xx (installed in `preparePartition`, filter by
  URL; Electron keeps one listener per `webRequest` event and session, so `sign-out.ts` owns
  `onCompleted` and nothing else registers it).
- [ ] `complete(profileId)`: `update({ signedIn: false })`, `closeProfileWindows`, small window
  signed-out page (board `SignedOut`: icon at 0.85 opacity, 「已退出 <平台>」, the account login and,
  when `device@1` status says this machine is that deployment's device, 「这台电脑仍作为设备连接着」;
  「在浏览器中重新登录」 → K3 `begin` → main window on `/`; 「添加其他平台」 → connect;
  「移除这个平台」 → the existing removal flow).
- [ ] `confirmAndSignOut`: K6 dialog (board `SignOut` copy, `tone: "primary"`), then the logout
  POST through the partition fetch (CSRF header, `credentials: include`), then `complete`
  whatever the POST answered (a dead session is signed out too); also clear `cap_at` / `cap_rt`
  from the partition's cookie jar.
- [ ] App menu 「平台」: profiles as radio items with `CmdOrCtrl+1…9`, separator, 「添加平台…」,
  「退出登录 <平台>…」 (current signed-in profile; disabled otherwise), 「移除这个平台…」 (hidden
  under `lockDeployments`). The tray keeps its own profile list.
- [ ] Tests: menu template; complete/confirm flows with fakes; the logout filter matches only the
  profile's own base.

## Task K8: theme and language (high: cookie writes)

**Files:** `apps/desktop/src/main/appearance.ts`, `src/main/capabilities.ts` (chrome),
create `src/main/preferences.ts`; modify `src/main/index.ts`, tests.

- [ ] `chrome@1.setAppearance` accepts and validates `tokens` (all seven `isColor`, else the call
  fails) and `singleScheme` (boolean); stores `appearance` on the profile (K4 `update`), sets the
  window background to `tokens.bg` or `background` (hex only for Electron: convert `rgb()` to hex
  or keep `background`), Windows title bar overlay colors, and pushes the new appearance to that
  profile's local pages.
- [ ] `preferences.ts`: `readTheme(profile)` / `readLocale(profile)` from the partition's cookies
  (`cb-theme`, `NEXT_LOCALE`; values validated: `light|dark`, `zh|en`); `setTheme(profile, t)` and
  `setLocale(profile, l)` write the cookie for the profile's origin with `path=/`,
  `expirationDate = now + 1 year`, `sameSite: "lax"`, `secure` only on https, never `httpOnly`
  (the web reads them); values are only ever from the fixed sets. With no profile: app-level
  `preferences.json` in userData (`{ theme?, locale? }`), else the OS (`nativeTheme`,
  `app.getLocale()`); the stored choice seeds a new profile's cookies at `profiles.add`.
- [ ] Local pages: `prefs.setTheme` / `prefs.setLocale` actions for the page's profile (or app
  level), then re-push state to every local page of that profile; the menus re-render in the
  chosen language.
- [ ] Tests: cookie attributes, refusal of anything outside the sets, seeding, validation of
  tokens, single-scheme hides the toggle in the page state.

## Task K9: expired and unreachable pages in the main window

**Files:** create `apps/desktop/src/main/session-watch.ts`, `src/main/overlay.ts`,
`src/local/pages/main-error.{html,ts}`; modify `src/main/windows.ts` (hook the watcher into
profile windows), `src/main/index.ts`, tests.

- [ ] Overlay: a `WebContentsView` with the local preload added to the main window's
  `contentView`, sized to the window (resize listener), the web contents hidden
  (`setVisible(false)` on the web view or the overlay covering it) while it shows; removed on
  success.
- [ ] Expired: `will-navigate` and `will-redirect` to `<base>/login…` on the profile origin →
  `preventDefault`, then: `signOut.takeLoggedOut(id)` → `signOut.complete(id)`, else the expired
  overlay; `did-navigate` / `did-navigate-in-page` to `/login` (client navigations that cannot be
  prevented) → the same decision. `returnTo` from the URL's query when it is a same-origin path,
  else the last non-login URL. 「在浏览器中重新登录」 → K3 `begin`; ok → `update({ signedIn: true,
  account })`, remove the overlay, load the return URL; failure → the overlay shows the sign-in
  error inline. 「退出登录」 → `signOut.complete`. 「切换平台」 → the 「平台」 menu as a popup.
- [ ] Unreachable: `did-fail-load` for the main frame with an error other than `-3` (aborted), or
  `did-navigate` with `httpResponseCode` 502/503/504 → the unreachable overlay with the elapsed
  time; probe `/api/v1/meta` through the partition fetch every 5 s for a minute, then every 30 s
  (injected scheduler); on a 2xx meta: remove the overlay and reload the failed URL. 「重试」 probes
  now.
- [ ] Board `MainErrors` layout: no web sidebar, 52 px drag band, content 380 px wide centered.
- [ ] Tests: decision table (login after logout / without / with returnTo / off-origin ignored),
  probe backoff, overlay lifecycle with fakes.

## Task K10: end-to-end smoke

**Files:** `apps/desktop/e2e/smoke.spec.ts` (split into files if clearer), `e2e/README.md`,
`packages/shell/test/fixtures/fake-deployment.ts`.

- [ ] Fake deployment: switches for meta shapes, `appRedirectUris`, token errors, a `/login`
  redirect for a protected page without a session, `POST /api/v1/auth/logout`, a 503 mode.
- [ ] Specs (keep the existing security ones, rewritten for the new entry): first launch shows
  the small window (480×600, not resizable) on connect; a bad address shows `not_capybara` inline;
  connect → found (name, host) → 在浏览器中登录 (stubbed `openExternal` captures the URL) →
  waiting → callback deep link → the small window closes and the main window is on `/`;
  `access_denied` callback → the cancelled error; the web's logout + `/login` → the signed-out
  small window; an expired session (cookie removed, reload) → the expired overlay in the main
  window; a shell dialog (remove platform) opens as its own window and its cancel keeps the
  profile; the theme toggle in a local page writes `cb-theme` into the profile partition.
- [ ] README coverage list updated. `pnpm e2e` green locally and in CI.

## Done

- [ ] Final whole-branch review on opus (clients wave PRs together, core C1).
- [ ] Unsigned dmg built locally for the maintainer; path in the report.
- [ ] Core: Version Packages PR merged when C1 needs a release for the web/sdk; prod upgraded per
  the deployment notes (backup first).
