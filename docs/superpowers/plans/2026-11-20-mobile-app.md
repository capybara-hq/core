# Mobile app shell (phases 1–3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. With 34 tasks across two repositories (26 planned on 2026-11-20, 10 added and 1 superseded on 2026-11-21), `wave-planned-subagent-development` governs the dispatch (wave tables below).

**Goal:** The official Capybara app for iOS and Android (`capybara-hq/clients` `apps/mobile`): it
loads a deployment's own web with native chrome (tab bar, share, haptics, menus, appearance,
Safari / Custom Tabs sign-in). The web gets the native-feel pass, which the browser and the PWA
get too. Organizations can fork, rebrand and release it. Push is not in this plan.

**Amendment 2026-11-21 (the maintainer's touch decisions).** The specs were amended on
`docs/mobile-touch-decisions` (layout spec §4.1–§4.6, §8; mobile app spec §5, §6.1, §8): the
compact shell is chat-first (a menu button and a drawer, no bottom navigation, the Me page
retired), touch has its own token and component set, management pages are desktop-only on touch,
and native navigation exists only in the iPhone Duo's strip through a new `nav@1` shape. This plan
keeps every done task as written and marks what the amendment supersedes in place ("Superseded
2026-11-21"). New work: core Tasks 23–30 (Phase 2b) and the amended Task 9; clients Tasks 31–32,
which replace Task 19, and the amended Task 16. The remaining-work wave table follows the original
one.

**Maintainer decisions 2026-11-21 (the touch open questions, now in layout spec §15).** (1) No
voice button: the composer is attach, input and send, dictation is the system keyboard's
(Task 26). (2) System back closes an open drawer or sheet first, then navigates: the web holds
one history entry per open drawer or sheet (Tasks 25, 27, 28); the native `decideBack` is
unchanged (Task 16). (3) The Duo inner display has the strip too (Task 31). (4) No 无痕会话
button; the home's trailing slot stays empty (Tasks 27, 28).

**Architecture:**
- **Core (`capybara-hq/core`).**
  - `@capybara-hq/plugin-sdk` gains the capability shapes `nav@1`, `haptics@1`, `share@1`,
    `menu@1` and `chrome@1` (with `ready`).
  - The kernel and the consent page accept a `mobile` app client.
  - `packages/design` takes the native handlers as props / provider values (it imports nothing
    from a shell) and does the touch, transition and Duo edge-to-edge pass in its CSS.
  - `apps/web` reads the capabilities only in `lib/shell.ts` and hands them to design.
- **Clients (`capybara-hq/clients`).**
  - `apps/mobile`: Capacitor, with the iOS (Swift) and Android (Kotlin) projects checked in.
  - Capacitor's own WebView shows only local pages: the address page, the error state and the
    TypeScript runtime. The runtime holds the capability registry, the validation, the profiles
    and the sign-in logic.
  - Each profile's remote origin loads in a separate native WebView. That WebView carries no
    Capacitor bridge, only a document-start script defining `window.capybaraShell` and one native
    message handler. The handler drops every message that is not from the main frame on the
    profile's exact origin, then forwards it to the runtime.
  - `packages/shell` grows the pure pieces the desktop and the mobile app share.

**Tech Stack:**
- Core: TypeScript, React / Next 16, design CSS, Nest kernel, vitest (jsdom), Playwright (visual
  baselines only via `visual-update`).
- Clients:
  - Capacitor (the current major at scaffold time, exact pins) with the official `@capacitor/haptics`,
    `@capacitor/share`, `@capacitor/preferences` and `@capacitor/splash-screen` plugins.
  - Swift (WKWebView, UITabBarController, ASWebAuthenticationSession, XCTest / XCUITest).
  - Kotlin (androidx.webkit, Material 3 NavigationBar, Custom Tabs, JUnit, instrumented tests).
  - vitest, fastlane, GitHub Actions.

**Spec:** [mobile app](../specs/2026-11-20-mobile-app-design.md) (binding; §9 push and the
`push@1` / `push-provider@1` contracts belong to the separate push plan). Also read
[mobile layout](../specs/2026-11-19-mobile-layout-design.md) §4, §7, §8, §9, §11 and the
[desktop client spec](../specs/2026-11-07-desktop-client-design.md) §6.5, §7, §8. Skills:
- Core design / web tasks: [writing-web-ui](../../../.agents/skills/writing-web-ui/SKILL.md),
  always.
- Shell surface: [writing-extension-ui](../../../.agents/skills/writing-extension-ui/SKILL.md).
- Task 3: [writing-kernel-api](../../../.agents/skills/writing-kernel-api/SKILL.md).
- Clients tasks: read `AGENTS.md` of `capybara-hq/clients` first. Read main with
  `git -C <clients> show origin/main:<path>`; the local checkout may be stale.

## Global Constraints

**Both repositories**
- Conventional Commits, body lines ≤ 100 characters, English code / comments / identifiers.
- A changeset for every changed published or versioned package. Core: `@capybara-hq/plugin-sdk`
  (with `pnpm gen:sdk-api`), `@capybara-hq/kernel`, `@capybara-hq/web`. Clients:
  `@capybara-hq/mobile`, `@capybara-hq/desktop` when it changes. The shell package is private and
  versioned.
- Tests:
  - No fixed sleeps, no per-test timeouts.
  - No real Keychain, Preferences, network, OS services or WebView in vitest: injected fakes
    only.
  - Native tests (XCTest / JUnit) cover the origin gate and the profile store. The device /
    simulator tests (XCUITest / Android instrumented) serve their test pages from a local loopback
    server started by the test.
- UI text in zh and en. The zh copy says 平台 / 超级管理员 / 智能体, never 企业 or the Latin word
  `agent`. Core: `pnpm check:i18n`. Clients: the shell catalog, `pnpm check:i18n`.

**Core**
- Run tests from the repo root: `pnpm exec vitest run <path>`. Design tests:
  `pnpm exec vitest run --project design <path>`.
- apps/web writes no styles (`check:web-ui`). `window.capybaraShell` is read only in
  `apps/web/src/lib/shell.ts` and design's `shell/shell-environment*.tsx` (`web-shell-access`).
  Design imports nothing from a shell or from plugin-sdk.
- `apps/web/src/lib/shell.ts` mirrors `packages/plugin-sdk/src/shell-capabilities.ts` from
  `export const SHELL_CAPABILITY_KEYS` to the SDK file's end, byte for byte, up to its first
  accessor (`apps/web/test/shell-types-mirror.test.ts`). New shapes go at the SDK file's end and
  into the mirror before `export const useDeviceCapability`.
- Detection by capability key only (`name@major`); an absent capability means the browser. Never
  the user agent or `kind`.
- Visual baselines only through the `visual-update` workflow; never commit `*-darwin.png`.

**Clients**
- Core packages from npm only, at exact versions (`@capybara-hq/plugin-sdk`). No `workspace:`
  links into core and no `@capybara-hq/design`. In-repo packages link with `workspace:*`.
- `apps/mobile/brand.ts` is the only brand file. Native code namespaces are fixed: Swift module
  `App`, Kotlin package `com.capybarahq.shell`. Only the identifiers come from the brand.
- Capacitor's bridge (`window.Capacitor`, `Capacitor.Plugins.*`) is never present in a profile
  WebView (spec §5.3).

**Values (copy exactly)**

| Item | Value |
|---|---|
| Official ids | bundle id / application id `com.capybarahq.mobile`; scheme `capybara`; redirect `capybara://auth/callback` |
| Shell environment | `version: 1`, `kind: "mobile"`, `platform: "ios" \| "android"`, `shellVersion` = app version, `controls` absent |
| Capabilities | `signIn@1`, `openExternal@1`, `chrome@1`, `haptics@1`, `share@1`, `menu@1`; `nav@1` on iOS only while the window has a strip; `profiles@1` unless locked to one deployment (`push@1`: push plan); never `device@1`, `notify@1` (amended 2026-11-21) |
| `insets` | All 0 (amended 2026-11-21: no native bottom bar; the strip arrives as `env(safe-area-inset-right)`, spike 1.4). Superseded: "`bottom` = the native tab bar's height" |
| Nav section ids | `chats`, `inbox`, `agents`, `schedules`, in that order (amended 2026-11-21; the tab ids `chats`, `agents`, `inbox`, `me` are withdrawn) |
| Section routes | `chats` `/`, `inbox` `/inbox`, `agents` `/agents`, `schedules` `/schedules` |
| Touch query | `(pointer: coarse), (any-pointer: coarse) and (not (any-pointer: fine))` (`TOUCH_QUERY`) |
| Desktop-only route prefixes (touch) | `/plugins`, `/extensions`, `/channels`, `/settings`, `/evals`, `/trajectories`, `/admin` |
| Haptic kinds | `selection`, `light`, `success`, `warning` |
| Haptic uses | a section switch from the strip (was: tab switch) and a selection change `selection`; sending a message `light`; an approval granted `success`; a destructive confirmation `warning` |
| Data stores | iOS `WKWebsiteDataStore(forIdentifier:)`, iOS 17 minimum; Android `androidx.webkit` multi-profile, else one deployment at a time with a cleared store on switch |
| Managed keys | `presetUrl` (string), `lockToPreset` (boolean): iOS AppConfig `com.apple.configuration.managed`, Android managed configurations |
| Sign-in | iOS `ASWebAuthenticationSession` (`prefersEphemeralWebBrowserSession = false`), Android Custom Tabs; `/apps/authorize`; `POST /api/v1/app-auth/token` with header `X-Capybara-Csrf: 1`, `credentials: "include"`, `redirect: "error"`; TTL 10 min (`SIGN_IN_TTL_MS`); exchange timeout 30 s |
| In-WebView block | `POST <base>/api/v1/auth/login` and `<base>/api/v1/auth/sso/<provider>/start` (any method) |

## Decisions this plan adds to the spec

Each stays inside the spec's intent. Task 1.5 copies them into the spec as one-line follow-ups.

1. **Mobile app client in the kernel** (spec §4.3 assumes it; core accepts only `"desktop"`
   today):
   - `AppAuthorizeBodySchema.client` becomes `z.enum(["desktop", "mobile"])`.
   - The session user agent is `Capybara Mobile/<appVersion> (<name>)` for `mobile`.
   - The consent page and its errors name the client: 「在 {machine} 上的 Capybara 移动端登录
     {platform}？」.
2. **Capability shapes and limits** (`MOBILE_SHELL_LIMITS`, Task 2):
   - nav label 1..32; count an integer 0..9999.
   - Menu: 1..12 items; label 1..64; title ≤ 128; item id `^[A-Za-z0-9_.-]{1,64}$`.
   - Share: title ≤ 256, text ≤ 4000, url ≤ 2048.
   - `menu@1.show` `anchor` is a rect `{ x, y, width, height }` in CSS px from the WebView's top
     left. `share@1.share` resolves `void`, whether shared or dismissed.
3. **`chrome@1.ready` is optional** on the type. The design calls it once per document, after
   hydration, in the next animation frame. Splash fallback: the shell drops the splash on
   `ready()`, on the error state, or 3 s after the main-frame load finished (webs older than this
   plan never call `ready`).
4. **`data-native-nav` before the first paint.** `ShellEnvironmentScript` sets it on `<html>` when
   `nav@1` is present. The AppShell also sets it on the shell element (spec §6.1). The CSS drops
   the bottom-nav slot under either. **Amended 2026-11-21:** `nav@1` is present exactly while the
   strip shows, so the attribute means "the strip shows"; the CSS drops the web's section entries
   and its menu button under it, and the AppShell clears both attributes when the capability goes
   (Task 30).
5. **Capabilities run in the TypeScript runtime** (the local Capacitor WebView). Native first
   gates frame and origin, then forwards. The runtime re-checks the origin, validates, gates user
   activation and one dialog per profile, then calls native ports. If spike 1.2 rules for plain
   native shells, the same runtime runs in a hidden local WKWebView / WebView behind the same
   `HostPort` contract.
6. **The code exchange's world.** iOS runs it with `callAsyncJavaScript` in
   `WKContentWorld.defaultClient`, so page scripts cannot patch its `fetch`. Android runs it with
   `evaluateJavascript` in the page world. This is accepted: only the profile's own top frame on
   its origin can observe it, the same trust as the page itself.
7. **Blocking in-WebView sign-in.**
   - iOS cannot intercept `fetch`. It uses a `WKContentRuleList` generated by TypeScript
     (`signInBlockRules(base)`) plus a navigation-policy cancel.
   - Android uses `shouldInterceptRequest` (and the `ServiceWorkerClient`) with a Kotlin port of
     `isInWindowSignIn`.
   - All three implementations pass one shared vector file.
8. **Managed configuration versus the brand.** A brand with `lockToPreset: true` wins: MDM cannot
   change its preset. Otherwise a valid managed `presetUrl` / `lockToPreset` overrides the
   brand's. While locked, other profiles are hidden and never loaded; their stores stay until the
   lock lifts.
9. **Android single-store fallback.** Switching asks first: 「切换平台会退出当前平台的登录」,
   buttons 「切换」 / 「取消」.
10. **Android sign-in cancel.** Custom Tabs gives no dismiss signal. When the activity resumes
    with an attempt pending and no callback delivered in that resume, the attempt resolves
    `cancelled`.
11. **Brand generation:** the generator writes `ios/App/Brand.xcconfig`, `android/brand.properties`
    (the projects read their identifiers from them), the icon / splash sets and
    `brand-assets.sha256` (source hash); the drift check compares the text files byte for byte
    and the hash.
12. **Menus are custom native** (disabled items, anchor): UIAlertController `.actionSheet` with a
    popover `sourceRect` on iPad, and a Material modal bottom sheet on Android. Haptics and share
    use the official Capacitor plugins.
13. **Builds:** build number = `github.run_number` (CFBundleVersion / versionCode); marketing
    version from `apps/mobile/package.json`; secret names fixed in Task 21.
14. **Tab icons per id** (SF Symbol / Material): `chats` `bubble.left.and.bubble.right` /
    `chat_bubble`; `agents` `person.2` / `smart_toy`; `inbox` `tray` / `inbox`; `me`
    `person.crop.circle` / `account_circle`. **Superseded 2026-11-21:** SF Symbols only (Android
    draws no bar): `chats` `bubble.left.and.bubble.right`, `inbox` `tray`, `agents` `person.2`,
    `schedules` `clock`; the strip's menu button `line.3.horizontal`.
15. **Touch prefetch** (spec §7.3): today only Next's link prefetch exists on the client. apps/web
    adds `warmRoute`, which runs the route table's queries, on `pointerdown` and when a
    conversation row scrolls into view.

Added 2026-11-21 (the spec amendment's designer's calls, restated for the tasks):

16. **Touch scope** is the media query `TOUCH_QUERY` (Values), the design's existing touch
    definition. `tokens.json` gains a `touch` block of overrides that `gen:tokens` emits inside
    that query; no `data-touch` attribute, no script. `useTouch()` reads it after hydration only
    where a tree differs (the gate).
17. **One compact shell for every pointer.** `BottomNav`, `TopBar` and `MePanel` are deleted, not
    kept for a fine pointer; a narrow desktop window gets the chat-first shell at desktop sizes.
18. **The drawer's 「技能、连接器、设备…」 is a second drawer level**, not a route.
19. **Back with no history** goes to the last linked segment of the page's path, else `/`.
20. **The gate** renders the notice and the page on the server and lets the touch query show one;
    after hydration it mounts only one. Routes are flagged `desktopOnly` in the route table; a web
    test pins the prefixes. Presentation only: the kernel decides access.
21. **`nav@1` presence is the strip**: the shell offers it only while the window has a strip and
    removes it (with `change`) when the strip goes. `menu` is non-null exactly while the web's
    class is compact. The strip host is chosen by `StripDetector` (reserved region, else a
    trailing-only side safe area), never by the device model.
22. **Android has no `nav@1`** and no native navigation; foldables follow the no-strip rule.
23. **`profiles@1.show()`** opens the native profile switcher from the web's account sheet (the
    long-pressed 我 tab is gone); it returns nothing to the page and is not offered when the app is
    locked to one deployment.
24. **No voice button** in the floating composer (maintainer decision 2026-11-21): it is attach,
    input and send, and dictation is the system keyboard's; a voice-conversation mode is a later
    design. The composer has no `voice` slot.
25. **Back closes an open overlay first** (maintainer decision 2026-11-21, layout spec §15). The
    overlay's owner is the web: opening the drawer or a bottom sheet on a compact touch window
    pushes one history entry (`history.pushState` with a marker in `history.state`), closing it
    by any other means (scrim, drag, pick, Escape) pops that entry with `history.back()`, and a
    `popstate` that lands on a state without the marker closes the overlay. Android's back and
    the iOS edge swipe therefore need no native overlay knowledge.
26. **The Duo inner display has the strip** (maintainer decision 2026-11-21): native strip
    navigation applies on both displays.
27. **No incognito conversation (无痕会话) button** (maintainer decision 2026-11-21): the home's
    trailing floating slot stays empty.

## Review Focus

1. **A hostile frame or a navigated-to origin.** Cases: a same-origin `/plugin-ui` iframe, a
   cross-origin iframe, or the top frame after navigating to an SSO identity provider, each
   posting straight to the native handler. Expected: dropped natively, `capybaraShell` undefined
   there, and `window.Capacitor` undefined in every remote document. Pinned by Task 1.2 (spike)
   and Task 13 (XCUITest + Android instrumented `hostile-page` cases).
2. **A sign-in callback out of place.** Cases: replayed, carrying another profile's state,
   arriving after the profile was removed, or arriving while the profile WebView is off its
   origin. Expected: no exchange, and the page's promise settles. A Custom Tabs dismissal
   resolves `cancelled` on resume. Task 17 tests each.
3. **Spellings of the login and SSO routes inside the WebView:** `//api`, upper case,
   `%6cogin`, a trailing slash, a base path prefix. Expected: blocked on both platforms. Tasks 10
   and 17 run the shared vectors in vitest, XCTest and JUnit.
4. **Managed configuration and the brand.** Cases: a malformed or `http:` `presetUrl`, a
   `lockToPreset` without a preset, a brand-locked build receiving another managed preset, and a
   managed change while the app runs. Expected: each bad field is ignored, the brand lock wins,
   and a runtime change re-applies without deleting other profiles' stores. Task 18.
5. **Opening the Duo or turning the phone while the native bar shows,** or the keyboard opening.
   Expected: never two tab bars; `insets.bottom` returns to 0 when the bar hides; a back swipe
   animates once. Tasks 4, 7 and 19. **Superseded 2026-11-21** by item 7 (no bottom bar exists;
   insets stay 0).
6. **The desktop stays as it was** (2026-11-21). Cases: `tokens.css` outside the touch block, the
   1440 baselines, a tablet with a mouse as its primary pointer, a narrow desktop window. Expected:
   unchanged declarations and baselines; desktop sizes with a fine pointer. Tasks 24–27.
7. **Never two navigations** (2026-11-21). Cases: the strip appearing or going (fold, rotate, a
   scene resize), the first paint with the strip, a guest (no 定时任务), a class change while the
   drawer is open, `onMenu` twice. Expected: the web's section entries and menu button hidden
   exactly while `nav@1` exists (on `<html>` and the shell element, both ways); never a native bar
   on an ordinary phone, an iPad or Android; one tab bar in the hierarchy. Tasks 30, 31.
8. **The management gate** (2026-11-21). Cases: a management URL opened on touch with and without
   JavaScript, a member and an org admin, the command palette, `/account/*`. Expected: only the
   notice shows on touch, the page's subtree is never mounted after hydration and its queries
   never run; no management entry is reachable from touch navigation; personal settings are not
   gated. Task 29.
9. **`profiles@1` leaks nothing** (2026-11-21). Cases: a page calling `show()` without a
   gesture, twice at once, in a locked build. Expected: `no_activation`, `busy`, absent; the
   promise resolves `undefined` whatever is chosen, and no profile name or origin reaches the
   page. Task 32.

---

## Cross-repo dependencies and seams

| Needs | From | Used by |
|---|---|---|
| Spike rulings (Capacitor or plain native, tab host, insets.right, Android profiles) | Tasks 1.1–1.5 | 11, 13, 14, 16, 19 |
| `@capybara-hq/plugin-sdk` release with Task 2's types (the core Version Packages PR) | Task 2 | Clients 13, 16, 20 (bump the exact version; 19 superseded) |
| `@capybara-hq/plugin-sdk` release with Task 23's `nav@1` / `profiles@1` (2026-11-21) | Task 23 | Clients 31, 32 |
| A dev deployment running Task 30's strip-aware web (2026-11-21) | Task 30 | Task 31's manual Duo check |
| Kernel accepting `client: "mobile"`, in a released kernel | Task 3 | Task 17 (its e2e against a dev kernel) |
| `packages/shell` lifts | Task 10 | 13–18 |

**Seams left for the push plan (stated, not built):**
- The runtime's `CapabilityRegistry.register(key, impl, { available })`: `push@1` registers
  there, available only when the build has push credentials and meta lists it.
- `ProfileStore.onRemoved(listener)`: profile removal deletes the push registration there.
- `brand.ts`: the push plan adds its own optional `push` field. This plan adds none.
- The runtime's `DeepLinkRouter`: push taps that carry a deployment origin route through it to a
  profile.

Checked against the 2026-11-21 amendment: none of the four seams moves. Task 31 adds
`registry.refresh(profileId)` (re-evaluates `available` and pushes the descriptors with `change`);
it is additive and `register(key, impl, { available })` keeps its signature. Two things the push
plan relies on shift around it: the `nav@1` types now arrive with Task 23, not Task 2, so its C1 /
C9 rebase against Task 23 for `shell-capabilities.ts`, `lib/shell.ts` and the key-count test
(whichever lands second); and the notification settings of its C9 are reached on touch through
the drawer's account sheet (个人设置) instead of the retired Me page, with no change to its routes.
Push taps to `/inbox` land on a pushed page whose back goes to `/` when there is no history.

## Wave plan

Owners of shared files, one task per wave:
- Core: `shell.css` (6 → 4 → 7 → 9), `app-shell.tsx` (4 → 7), `design-root.tsx` (8 → 5), apps/web
  messages (3 only).
- Clients: `ShellPlugins.{swift,kt}` (13, then 14 adds one line after 13 merges), `ci.yml` (11,
  then 12).

| Task | Repo | Depends on | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1.1 Spike: shared WebView under UITabBarController, Duo strip | clients | — | normal | 1 | maintainer reads the result |
| 1.2 Spike: origin gate, iOS and Android | clients | — | **high** | 1 | alone, most capable |
| 1.3 Spike: Android multi-profile | clients | — | normal | 1 | batched |
| 1.4 Spike: Duo safe area, edge to edge | clients | — | normal | 1 | batched with 1.1 |
| 2 SDK capability types and registry | core | — | normal | 1 | batched |
| 3 Kernel and consent page: mobile app client | core | — | **high** (sign-in) | 1 | alone |
| 6 Touch pass | core | — | normal | 1 | batched |
| 10 `packages/shell` lifts | clients | — | normal | 1 | batched |
| 1.5 Record rulings in the specs | core | 1.1–1.4 | normal | 2 | maintainer |
| 4 Design native handles | core | 2 (shapes only) | normal | 2 | batched |
| 8 Perceived speed | core | — | normal | 2 | batched |
| 5 Web adapter and wiring | core | 2, 4 | normal | 3 | batched |
| 7 Transitions | core | 4 | normal | 3 | batched |
| 11 Scaffold and CI | clients | 1.5 | normal | 3 | batched |
| 9 Duo edge to edge (web) | core | 1.4, 7 | normal | 4 | batched |
| 12 Brand file, generator, drift check | clients | 11 | normal | 4 | batched |
| 13 Runtime, injected script, origin gate | clients | 1.2, 10, 11 | **high** | 4 | alone, most capable |
| 14 Profiles and data stores | clients | 1.3, 11 | normal (isolation) | 4 | batched, with 13's reviewer |
| 15 Address page and discovery | clients | 10, 12, 14 | normal | 5 | batched |
| 16 Loading, navigation, splash, appearance, errors | clients | 1.1, 13, 14, Task 2 release | normal | 5 | batched |
| 17 Sign-in and the in-WebView block | clients | 3, 10, 13, 14, 16 | **high** | 6 | alone, most capable |
| 18 Managed configuration | clients | 12, 14, 15 | **high** | 6 | alone |
| 19 `nav@1` native tab bar (**superseded 2026-11-21 by 31**) | clients | 1.1, 1.4, 13, 16 | normal | 6 | batched |
| 20 `haptics@1`, `share@1`, `menu@1`, `openExternal@1` | clients | 13 | normal | 6 | batched |
| 21 Release workflow | clients | 12 | normal (secrets) | 7 | batched |
| 22 Fork guide and docs | clients | 12, 17, 21 | normal | 7 | batched |

### Remaining work, amended 2026-11-21

Done when the amendment landed: Tasks 1.1–1.5, 2 (PR #477, `nav@1` withdrawn from it), 3, 4, 4b,
5, 6, 7, 8 (core PR C `feat/mobile-native-feel`, unpushed), 10–14 (clients). Task 19 is
superseded by Task 31 and never runs.

**Before PR C is pushed** (coordinator): drop the web adapter's `useNavCapability` /
`useNativeNavHandle` and AppFrame's `nativeNav` line from Task 5's commit, because they import
the withdrawn `NavCapabilityV1`; design's own `NativeNavHandle` (structural, no SDK import) stays
inert until Task 30 replaces it. The touch tasks then go on a new core PR F
`feat/mobile-touch`, branched from main after PR C merges.

Owners of shared files, one task per wave:
- Core: `app-shell.tsx` (27 → 29 → 30), `AppFrame.tsx`, `nav.tsx` and apps/web messages
  (28 → 29 → 30), `shell.css` (27 → 30 → 9), `tokens.json` and the generated token files (24
  only), `lib/shell.ts` (23 mirror → 30), `docs/design/spec.md` (24 → 25 / 26 in disjoint
  sections, merged additively → 27 → 28 → 29), `packages/design/test/touch.test.ts` (27 → 28).
- Clients: the runtime entry that registers capabilities (31 and 32 add one line each; the
  coordinator merges them), `registry.ts` (31 only).

| Task | Repo | Depends on | Risk | Wave | Review |
|---|---|---|---|---|---|
| 23 SDK `nav@1` (strip) and `profiles@1` | core | 2 merged | normal | T1 | batched |
| 24 Touch tokens and font roles | core | — | normal | T1 | batched |
| 15 Address page and discovery | clients | 10, 12, 14 | normal | T1 | batched |
| 16 Loading, navigation, splash, appearance, errors (amended) | clients | 1.1, 13, 14, Task 2 release | normal | T1 | batched |
| 25 Touch components: floating button, drawer, rows, sheet | core | 24 | normal | T2 | batched |
| 26 Touch components: conversation | core | 24 | normal | T2 | batched |
| 17 Sign-in and the in-WebView block | clients | 3, 10, 13, 14, 16 | **high** | T2 | alone, most capable |
| 18 Managed configuration | clients | 12, 14, 15 | **high** | T2 | alone |
| 20 `haptics@1`, `share@1`, `menu@1`, `openExternal@1` | clients | 13 | normal | T2 | batched |
| 27 Chat-first compact shell (design) | core | 25 | normal | T3 | batched |
| 31 Native strip and menu button (replaces 19) | clients | 1.1, 1.4, 13, 16, Task 23 release | normal | T3 | batched |
| 32 `profiles@1` | clients | 13, 14, 20, Task 23 release | normal (privacy) | T3 | batched, with 31 |
| 21 Release workflow | clients | 12 | normal (secrets) | T3 | batched |
| 28 Chat-first wiring in apps/web, `/me` retired | core | 27 | normal | T4 | batched |
| 22 Fork guide and docs | clients | 12, 17, 21 | normal | T4 | batched |
| 29 「请在电脑上管理」 and the touch route gate | core | 27, 28 | normal | T5 | batched |
| 30 `nav@1` strip rework of the native handles, `profiles@1` in the web | core | 23, 27, 28, 29 | normal | T6 | batched |
| 9 Duo edge to edge on the web (amended) | core | 1.4, 7, 27, 30 | normal | T7 | batched |

---

## Phase 1: spikes (clients)

Spikes run on branches `spike/mobile-<name>` in a clients worktree, under
`apps/mobile/spikes/<name>/`. They are never merged. Each ends with a short result note
(measurements, screen recordings, pass / fail per criterion), attached to the Task 1.5 PR. They
need Xcode 27.1 with the iPhone Duo Device Hub simulator, an Android emulator, and the Android
devices listed in 1.3.

### Task 1.1: Shared WebView under a UITabBarController (iOS 27.1, iPhone Duo)

**Files:** `apps/mobile/spikes/tabhost/` (a bare Swift app: one `WKWebView` loading a local page
with a counter, a long scroll and a text field).

- [ ] **Step 1:** Build a `UITabBarController` with four children. On selection
  (`tabBarController(_:didSelect:)`), move the single `WKWebView` into the selected child's view.
- [ ] **Step 2:** Measure on the iPhone 17-class simulator, the Duo outer display, the Duo inner
  display (portrait and landscape) and while opening and closing:

  | Criterion | Pass |
  |---|---|
  | No reload on tab change | the same `performance.timeOrigin`, counter and scroll position after 20 switches |
  | No blank frame | a screen recording shows no frame without web content during a switch |
  | Placement | the standard bar on a phone; the vertical bar in the right strip under the status bar on the Duo outer display, as the App Store places it |
  | Hide / show | `tabBar.isHidden` / `setTabBarHidden(_:animated:)` driven from the page (a fake `nav@1.set({visible})`) hides it with no layout jump and no second bar |
  | Focus | the text field keeps focus and the keyboard across a programmatic `selectedIndex` change |
  | Back swipe | `allowsBackForwardNavigationGestures` works inside the moved WebView |

- [ ] **Step 3: Fallback, as the spec requires.** If any criterion fails, build the custom bar
  placed with `UIViewReservedRegion` (iOS 27.1) and run the same table against it. Record which
  host Task 19 uses.
- [ ] **Step 4:** Write the result note.

### Task 1.2: The origin gate on iOS and Android — high risk

**Files:** `apps/mobile/spikes/gate/{ios,android}/`, `apps/mobile/spikes/gate/testpages/`. The
loopback server serves origin A `http://127.0.0.1:<p>` and origin B `http://localhost:<p>`. Origin
A has `/top.html`, `/frame-same.html` (an iframe of A) and `/frame-cross.html` (an iframe of B).
Origin B has `/navigated.html`, reached by a top-level link from A.

- [ ] **Step 1: iOS.**
  - A `WKUserScript` with `injectionTime: .atDocumentStart` and `forMainFrameOnly: true`. It
    defines `window.capybaraShell` only when `location.origin === <profile origin>`.
  - One `WKScriptMessageHandlerWithReply` named `capybaraShell`. It accepts only
    `message.frameInfo.isMainFrame` with `frameInfo.securityOrigin` equal to the profile origin
    (scheme, host, port).
  - Capacitor runs in the same app, with its bridge WebView showing a local page.
- [ ] **Step 2: Android.**
  - `WebViewCompat.addDocumentStartJavaScript(webView, script, setOf(origin))`, with the script
    bailing out when `window !== window.top`.
  - `WebViewCompat.addWebMessageListener(webView, "capybaraShellPort", setOf(origin), listener)`,
    with the listener accepting only `isMainFrame && sourceOrigin == origin`.
- [ ] **Step 3: The hostile page.** Each page tries, and reports to the test via a title change:
  - read `window.capybaraShell`;
  - post directly to `window.webkit.messageHandlers.capybaraShell` / `capybaraShellPort`;
  - read `window.Capacitor` and `window.webkit.messageHandlers.bridge`;
  - redefine `capybaraShell` before the script.

  Pass, in every one of A-top / A-frame-same / A-frame-cross / B-navigated: only A-top sees the
  shell and gets a reply; the native side logs a drop for every other post; `window.Capacitor` is
  undefined in all four.
- [ ] **Step 4: The ruling input.** Record whether Capacitor's single configured WebView coexists
  with separate profile WebViews (no Capacitor injection into them, no shared process-pool
  surprise, profile WebViews created and destroyed freely). The spec says: if the gate, the
  per-profile stores (1.3) or the shared tab-bar WebView (1.1) mostly fight Capacitor, the app
  becomes **plain native shells** (Swift / Kotlin hosting the WebViews, Capacitor only for the
  local pages or dropped). Everything else in this plan stays (Decision 5).
- [ ] **Step 5:** Write the result note.

### Task 1.3: Android multi-profile WebView

**Files:** `apps/mobile/spikes/profiles-android/`.

- [ ] **Step 1:**
  - Check `WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)`.
  - Create two profiles via `ProfileStore.getInstance().getOrCreateProfile(name)` and give two
    WebViews one each with `WebViewCompat.setProfile`.
  - Sign in to a dev kernel in one.
  - `deleteProfile(name)`.
- [ ] **Step 2: Pass.** The cookie and localStorage of profile 1 are invisible in profile 2. The
  session survives an app restart. After `deleteProfile`, a recreated profile of the same name is
  empty.
- [ ] **Step 3: Measure** on a current Pixel emulator, an emulator at minSdk, and one device each
  from Huawei / Honor and Xiaomi (WebView provider and version). Record the minimum WebView
  version that has the feature and the share of target devices without it. The spec's fallback,
  where it is missing: one deployment at a time with a cleared store on switch (Decision 9).

### Task 1.4: iPhone Duo safe area and edge to edge

**Files:** `apps/mobile/spikes/duo/` (may share 1.1's app). The page uses
`viewport-fit=cover` and prints `env(safe-area-inset-*)`, `visualViewport` and the presence of
`navigator.devicePosture` and `window.viewport?.segments`.

- [ ] **Step 1:** Set the WebView's `scrollView.contentInsetAdjustmentBehavior = .never` and
  pin it to the superview's edges, ignoring the safe area.
- [ ] **Step 2: Record on the outer display:**
  - Does `env(safe-area-inset-right)` equal the strip's width? If yes, `insets.right` is 0. If
    no, the shell passes the strip width as `insets.right`.
  - Do backgrounds draw under the strip with the tab bar over it?
  - Does the status bar stay readable?

  Record on the inner display, open and closed: the size class changes, and posture / segments
  support. These answer layout spec §15 Q1 and Q2.
- [ ] **Step 3: Pass.** Content can run edge to edge under the strip with a known right inset (from
  either source). If the strip cannot be drawn under at all, record it: the UIViewReservedRegion
  path of 1.1 Step 3 then decides placement.

### Task 1.5: Record the rulings (core docs)

**Files:** Modify `docs/superpowers/specs/2026-11-20-mobile-app-design.md` (a new §15 "Spike
results" with a dated ruling per open question of §14; this plan's Decisions as one-liners) and
layout spec §15 (answers to Q1 and Q2).

- [ ] **Step 1:** Write the rulings:
  - Capacitor or plain native shells.
  - The tab host: shared WebView or UIViewReservedRegion.
  - `insets.right`: from `env()` or from the shell.
  - Android: multi-profile or single-store, with the minimum WebView version.
- [ ] **Step 2:** `pnpm check:agent-docs` and `pnpm lint`. Commit `docs(specs): mobile app spike
  results`. A maintainer reviews this before Task 11 starts.

## Phase 2: core (web native-feel pass and contracts)

### Task 2: SDK capability types and registry

> **Superseded in part 2026-11-21.** The `nav@1` types below (`NavTabId`, `NavItemV1`,
> `NavStateV1` with `visible`, `NavCapabilityV1`) and the `nav` key were withdrawn from PR #477
> before release; Task 23 defines `nav@1` in the strip shape. Everything else stays.

**Files:**
- Modify: `packages/plugin-sdk/src/shell-capabilities.ts` (append), `src/shell-environment.ts`
  (`SHELL_CAPABILITIES`), `src/index.ts`; regenerate `api/plugin-sdk.api.md`.
- Modify: `apps/web/src/lib/shell.ts` (mirror only; accessors are Task 5).
- Modify: layout spec §9.2. Add rows `nav@1`, `haptics@1`, `share@1` and `menu@1` (owner: mobile
  app spec §5.2). Extend the `chrome@1` row with `ready()`. Replace "the mobile shell later, only
  if it needs…" with "the mobile shell always (status bar, WebView background, splash)".
- Create: `.changeset/mobile-shell-capabilities.md` (`"@capybara-hq/plugin-sdk": minor`).
- Test: `packages/plugin-sdk/test/shell-capabilities.test.ts`.

**Interfaces:**
- Produces (exact; the push plan appends `push@1` the same way):
  ```ts
  // SHELL_CAPABILITY_KEYS gains: chrome: "chrome@1", nav: "nav@1", haptics: "haptics@1",
  //   share: "share@1", menu: "menu@1"
  export interface ChromeCapabilityV1 {
    setAppearance(input: { scheme: "light" | "dark"; background: string }): Promise<void>;
    /** The web's first paint is done (mobile app spec §5.2); a shell may leave it out. */
    ready?(): Promise<void>;
  }
  export type NavTabId = "chats" | "agents" | "inbox" | "me";
  export interface NavItemV1 { id: NavTabId; label: string; count?: number; countMore?: boolean }
  export interface NavStateV1 { items: NavItemV1[]; current: NavTabId | null; visible: boolean }
  export interface NavCapabilityV1 {
    set(state: NavStateV1): Promise<void>;
    onSelect(listener: (id: NavTabId) => void): () => void;
  }
  export type HapticKind = "selection" | "light" | "success" | "warning";
  export interface HapticsCapabilityV1 { impact(kind: HapticKind): Promise<void> }
  export interface ShareInputV1 { title?: string; text?: string; url?: string }
  export interface ShareCapabilityV1 { share(input: ShareInputV1): Promise<void> }
  export interface MenuItemV1 { id: string; label: string; destructive?: boolean; disabled?: boolean }
  export interface MenuInputV1 {
    title?: string;
    items: MenuItemV1[];
    anchor?: { x: number; y: number; width: number; height: number };
  }
  export interface MenuCapabilityV1 { show(input: MenuInputV1): Promise<string | null> }
  export const MOBILE_SHELL_LIMITS = {
    navLabel: 32, navCount: 9999, menuItems: 12, menuLabel: 64, menuTitle: 128,
    shareTitle: 256, shareText: 4000, url: 2048,
  } as const;
  export const MENU_ITEM_ID = /^[A-Za-z0-9_.-]{1,64}$/;
  ```

- [ ] **Step 1: Failing tests** in `shell-capabilities.test.ts`:
  - `SHELL_CAPABILITY_KEYS` toEqual the nine keys above.
  - Every key appears in `SHELL_CAPABILITIES`, and the four new owners name the mobile app spec.
  - `expectTypeOf<ReturnType<MenuCapabilityV1["show"]>>().toEqualTypeOf<Promise<string | null>>()`.
  - `expectTypeOf<NavTabId>().toEqualTypeOf<"chats" | "agents" | "inbox" | "me">()`.
  - `expectTypeOf<ChromeCapabilityV1["ready"]>().toEqualTypeOf<(() => Promise<void>) | undefined>()`.
  - `MOBILE_SHELL_LIMITS` toEqual the values above.
  - `MENU_ITEM_ID.test("a.b-c_1")` is true, `MENU_ITEM_ID.test("")` is false.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/shell-capabilities.test.ts` —
  expect FAIL.
- [ ] **Step 3: Implement** the types and constants, and copy the block into `lib/shell.ts`
  before `export const useDeviceCapability`.
- [ ] **Step 4: Run** the test and `apps/web/test/shell-types-mirror.test.ts` — expect PASS. Then
  `pnpm gen:sdk-api && pnpm check:sdk-api && pnpm check:sdk-api-changeset && pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(sdk): mobile shell capability types`. After merge, the Version
  Packages PR publishes the SDK the clients pin.

### Task 3: Kernel and consent page: the mobile app client — high risk, review alone

**Files:**
- Modify: `packages/kernel/src/identity/app-auth.schemas.ts` (`client: z.enum(["desktop", "mobile"])`),
  `app-auth.ts` (`CodeGrant.client: "desktop" | "mobile"`, `appUserAgent`).
- Modify: `apps/web/src/app/(auth)/apps/authorize/{page,view}.tsx` (read and validate `client`;
  an unknown value shows the invalid-link state), `apps/web/messages/{zh,en}.json` (per-client
  title, subtitle, invalid hint, the two error texts; audit labels say 「应用」).
- Create: changesets `@capybara-hq/kernel: patch`, `@capybara-hq/web: patch`.
- Test: `packages/kernel/test/identity/app-auth.unit.test.ts`, `app-auth.http.test.ts`,
  `apps/web/test/app-authorize-page.test.tsx`.

**Interfaces:** Produces `appUserAgent({ client, appVersion, name })`:
- `desktop` → `Capybara Desktop/<v> (<name>)`.
- `mobile` → `Capybara Mobile/<v> (<name>)`.

- [ ] **Step 1: Failing tests.**
  - Unit: `client: "mobile"` passes the schema; `client: "tablet"` fails; `appUserAgent` gives
    both strings.
  - HTTP:
    - an authorize with `client: "mobile"` and redirect `capybara://auth/callback`, then the
      token exchange, gives a session whose `user_agent` is `Capybara Mobile/1.0.0 (iPhone)`;
    - the audit `auth.app_signed_in` detail has `client: "mobile"`;
    - a replayed code still answers `app_auth.code_invalid`.
  - Web: `?client=mobile` renders 「在 iPhone 上的 Capybara 移动端登录 Acme？」; `?client=x` renders
    the invalid hint and posts nothing.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/identity/app-auth.unit.test.ts packages/kernel/test/identity/app-auth.http.test.ts apps/web/test/app-authorize-page.test.tsx`
  — expect FAIL.
- [ ] **Step 3: Implement.** Keep the redirect allow-list unchanged: a fork's scheme still has to
  be listed in `auth.appRedirectUris`.
- [ ] **Step 4: Run** the tests, `pnpm check:i18n`, `pnpm check:platform-ops`, `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(kernel,web): sign in the mobile app client`.

### Task 4: Design native handles (nav, menu, share, haptics, ready)

> **Superseded in part 2026-11-21 (done; not rewritten).** Stays: `native.ts` menu / share /
> haptics, `useHaptics`, `isPlainMenu`, the native menu path, the haptic sites, `ShellReady`, the
> `DesignProvider` `native` prop, `ShellEnvironmentScript`'s `data-native-nav` from `nav@1`'s
> presence (it now means "the strip shows") and the handle-identity guard of fix round 1.
> Replaced by Task 30: the `NativeTabId` / `NativeNavHandle` shape, the `visible` computation, the
> hide-on-unmount call and the `[data-native-nav] .cb-shell-bottomnav` rule. Retired by Tasks 27–28:
> the bottom navigation the handle replaced.

**Files:**
- Create: `packages/design/src/native.ts` (types, `useNative()`, `useHaptics()`, `isPlainMenu`).
- Modify:
  - `src/provider.tsx` (`DesignProvider` prop `native?: NativeHandlers`);
  - `src/shell/app-shell.tsx` (prop `nativeNav`, `data-native-nav`, set / onSelect, haptic on
    select);
  - `src/shell/shell-environment-script.tsx` (`data-native-nav` on `<html>` when
    `capabilities["nav@1"]` is an own object);
  - `src/shell/shell-environment.tsx` (`ShellReady`);
  - `styles/shell.css` (`[data-native-nav] .cb-shell-bottomnav { display: none }`);
  - `src/overlays/menus.tsx` and `src/conversation/menu.tsx` (native path);
  - the composer's send, the hitl approve action and the destructive confirm dialog (haptics);
  - the select / segmented controls (`selection`).
- Test: `packages/design/test/native-nav.test.tsx` (new), `native-menu.test.tsx` (new),
  `haptics.test.tsx` (new), `shell-environment.test.tsx`.

**Interfaces:**
- Consumes: the shapes of Task 2, re-declared structurally in design (design imports no SDK).
- Produces:
  ```ts
  export type NativeTabId = "chats" | "agents" | "inbox" | "me";
  export interface NativeNavHandle {
    set(state: { items: { id: NativeTabId; label: string; count?: number; countMore?: boolean }[];
                 current: NativeTabId | null; visible: boolean }): void;
    onSelect(listener: (id: NativeTabId) => void): () => void;
  }
  export interface NativeHandlers {
    menu?(input: { title?: string; items: { id: string; label: string; destructive?: boolean;
      disabled?: boolean }[]; anchor?: DOMRectInit }): Promise<string | null>;
    share?(input: { title?: string; text?: string; url?: string }): Promise<void>;
    haptics?(kind: "selection" | "light" | "success" | "warning"): void;
  }
  export function useHaptics(): (kind: "selection" | "light" | "success" | "warning") => void; // no-op without handler
  export function isPlainMenu(items: readonly MenuItem[]): boolean;
  // AppShellProps gains: nativeNav?: NativeNavHandle; onNavigate?(href: string): void;
  export function ShellReady(): null; // calls chrome@1.ready() once per document
  ```

- [ ] **Step 1: Failing tests.**
  - **Nav.** With a fake `nativeNav` at compact width on a tab root with the keyboard closed:
    - `.cb-shell-bottomnav` is not displayed (computed `display: none` via the CSS rule test
      helper `parseCss`);
    - the shell has `data-native-nav`;
    - `set` was called once with the four items, `current: "chats"`, `visible: true`.
    - After that: a pushed route → `set` with `visible: false`; `data-keyboard="open"` →
      `visible: false`; medium width → `visible: false`; an unchanged rerender → no extra call.
    - `onSelect("inbox")` → `onNavigate("/inbox")` and `haptics("selection")`.
    - Unmount unsubscribes.
  - **Script.** With `capabilities: { "nav@1": {} }`, `<html>` gets `data-native-nav`; without it,
    it does not.
  - **Menu.** A `Menu` at compact with `native.menu` and plain items calls `native.menu` with the
    items and the trigger's rect as `anchor`. A resolved `"rename"` runs that item's `onSelect`;
    `null` runs nothing. A menu with a checkbox item, or at expanded width, opens the design
    popover. A rejection falls back to the design popover.
  - **Haptics.** Composer send → `light`; approve → `success`; confirming a destructive dialog →
    `warning`; changing a segmented control → `selection`. Without a handler nothing throws.
  - **ShellReady.** Calls `ready` once after a frame; not again on rerender. Skips silently when
    `ready` is absent or throws. Does nothing in an iframe.
- [ ] **Step 2: Run** `pnpm exec vitest run --project design packages/design/test/native-nav.test.tsx packages/design/test/native-menu.test.tsx packages/design/test/haptics.test.tsx packages/design/test/shell-environment.test.tsx`
  — expect FAIL.
- [ ] **Step 3: Implement.**
  - `visible` = compact class (hydrated `useSizeClass() === "compact"`) && tab root && no open
    keyboard. Dedupe by a JSON key of the state.
  - The menu's `anchor` comes from `getBoundingClientRect()` of the trigger. Long-press menus use
    the pressed row's rect.
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm typecheck`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor` (design ships in web). Commit `feat(design):
  native nav, menu, share and haptics handles`.

### Task 5: Web adapter and wiring

> **Superseded in part 2026-11-21 (done; not rewritten).** Stays: `useHapticsCapability`,
> `useShareCapability`, `useMenuCapability`, `useNativeHandlers`, `shareOrCopy`, `ShellReady` in
> `DesignRoot`, `onNavigate = router.push`. `useNavCapability`, `useNativeNavHandle` and AppFrame's
> `nativeNav` are dropped from PR C before it is pushed (they import the withdrawn types) and come
> back in the strip shape in Task 30.

**Files:**
- Modify: `apps/web/src/lib/shell.ts` (accessors), `components/shell/AppFrame.tsx`
  (`nativeNav`, `onNavigate`), `components/design-root.tsx` (`native` handlers),
  `app/layout.tsx` (render `<ShellReady />`).
- Modify: `components/file-preview/ShareDialog.tsx` and `components/conversation/ConversationView.tsx`
  (share), via a new `lib/share.ts`.
- Test: `apps/web/test/shell-adapter.test.tsx`, `apps/web/test/native-wiring.test.tsx` (new),
  `apps/web/test/share.test.ts` (new).

**Interfaces:**
- Consumes: Task 2 mirror types; Task 4's `NativeNavHandle`, `NativeHandlers`, `ShellReady`.
- Produces:
  ```ts
  export const useNavCapability: () => NavCapabilityV1 | undefined;
  export const useHapticsCapability: () => HapticsCapabilityV1 | undefined;
  export const useShareCapability: () => ShareCapabilityV1 | undefined;
  export const useMenuCapability: () => MenuCapabilityV1 | undefined;
  export function useNativeNavHandle(): NativeNavHandle | undefined; // nav@1 adapted
  export function useNativeHandlers(): NativeHandlers;               // only present capabilities
  // lib/share.ts
  export async function shareOrCopy(
    input: { title?: string; text?: string; url: string },
    deps: { share?: ShareCapabilityV1; webShare?: Navigator["share"]; copy(text: string): Promise<void> },
  ): Promise<"shared" | "copied">;
  ```

- [ ] **Step 1: Failing tests.**
  - Adapter: each accessor is `undefined` without the key, and the object after a `change` adds
    it.
  - `useNativeHandlers()` holds `menu` only when `menu@1` is present.
  - The `haptics` handler swallows a rejected `impact`.
  - Wiring: a fake shell with `nav@1` → AppFrame's shell gets `nativeNav`, and `onSelect("me")`
    navigates the router to `/me`.
  - `shareOrCopy`:
    - with `share@1` → shell share, `"shared"`;
    - without it but with `navigator.share` → Web Share;
    - neither → copy, `"copied"`;
    - a Web Share `AbortError` → `"shared"`, no copy.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/shell-adapter.test.tsx apps/web/test/native-wiring.test.tsx apps/web/test/share.test.ts`
  — expect FAIL.
- [ ] **Step 3: Implement.** Accessors follow the `useDeviceCapability` pattern. Every capability
  call happens in event-driven code (spec §9.4), never in render or an effect. `nav.set` is the
  one exception: it is not confirming, and the shell does not require an activation for it.
- [ ] **Step 4: Run** the tests, the mirror test, `pnpm check:web-ui` (incl. `web-shell-access`),
  `pnpm typecheck`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor`. Commit `feat(web): mobile shell capabilities
  in the adapter`.

### Task 6: Touch pass (spec §7.1)

> **Note 2026-11-21 (done; not rewritten).** Task 27 removes `.cb-bottomnav a` and
> `.cb-shell-topbar` from the audit lists of `touch.test.ts` when it deletes those parts, and adds
> the floating button, the drawer rows and the account sheet rows.

**Files:** Modify `packages/design/src/styles/{base,controls,shell,sidebar,table}.css`. Test:
`packages/design/test/touch.test.ts` (new, on `parseCss`), plus a jsdom case in `shell.test.tsx`.

- [ ] **Step 1: Failing tests** (`touch.test.ts`):
  - **Tap highlight and touch action.** A rule on `:where(a, button, [role="button"],
    [role="tab"], [role="menuitem"], summary, label, input, select, textarea)` declares
    `-webkit-tap-highlight-color: transparent` and `touch-action: manipulation`.
  - **Pressed states.** Every class matched by `.cb-btn`, `.cb-icon-btn`, `.cb-row-link`,
    `.cb-bottomnav a`, `.cb-sidebar-item`, `.cb-card[href]` (the audit list lives in the test, one
    entry per interactive design class) has an `:active` (or `[data-pressed]`) rule.
  - **No selection on chrome.** `.cb-shell-topbar`, `.cb-bottomnav`, `.cb-sidebar`, `.cb-btn` and
    `.cb-icon-btn` declare `user-select: none` and `-webkit-touch-callout: none`. No rule sets
    `user-select: none` on `.cb-prose`, `pre`, `code`, `input` or `textarea`.
  - **No rubber band.** `.cb-shell` and `html` declare `overscroll-behavior: none`. No rule in
    `user-scalable` / viewport CSS blocks pinch zoom.
- [ ] **Step 2: Run** `pnpm exec vitest run --project design packages/design/test/touch.test.ts` —
  expect FAIL.
- [ ] **Step 3: Implement** in design CSS only. Add any missing pressed state (ground
  `control.pressed` token) found by the audit.
- [ ] **Step 4: Run** the test, the design suite, `pnpm check:web-ui`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: patch`. Commit `feat(design): touch behaviour pass`.

### Task 7: Transitions (spec §7.2, §4.4)

> **Note 2026-11-21 (done; not rewritten).** "Root → root never slides" was keyed on the bottom
> navigation's tab roots. Task 27 re-keys it on chat surfaces (`/`, `/chat/<id>`); Task 30 keeps
> the "a native selection never slides" case with the strip's `onSelect`.

**Files:**
- Modify: `packages/design/src/shell/app-shell.tsx` (slide effect), `src/shell/view-transition.ts`,
  `styles/shell.css`, `styles/tokens.css`, `docs/design/tokens.json`, `docs/design/spec.md`
  (motion tokens).
- Test: `packages/design/test/transitions.test.tsx` (new), `tokens.test.ts`, `spec-tables.test.ts`.

**Interfaces:** Produces tokens:
- `--cb-motion-push: 350ms`, `--cb-ease-push: cubic-bezier(0.2, 0.9, 0.3, 1)` (iOS navigation
  default).
- Under `:root[data-shell-platform="android"]`: `--cb-motion-push: 300ms`,
  `--cb-ease-push: cubic-bezier(0.2, 0, 0, 1)` (Material emphasized).
- The outgoing page `transform: translateX(-30%)` with `filter: brightness(0.9)`.

- [ ] **Step 1: Failing tests.**
  - **UA transition.** A route change preceded by a `popstate` whose `hasUAVisualTransition` is
    true (defined on the event in jsdom) leaves `data-nav` absent and does not call
    `startViewTransition`. With `false`, `data-nav="pop-*"`.
  - **Tab switches.** Root → root (a tab switch, including via `nativeNav.onSelect`) never sets
    `data-nav`.
  - **CSS.** `cb-push-*` / `cb-pop-*` use `var(--cb-motion-push)` and `var(--cb-ease-push)`.
    `::view-transition-old(root)` under `[data-cb-transition="pop"]` declares the parallax and
    dim values. A `prefers-reduced-motion: reduce` block sets `animation: none` on
    `.cb-shell-main[data-nav]`.
  - The tokens tests see the two new tokens in `tokens.json` and the spec table.
- [ ] **Step 2: Run** `pnpm exec vitest run --project design packages/design/test/transitions.test.tsx packages/design/test/tokens.test.ts packages/design/test/spec-tables.test.ts`
  — expect FAIL.
- [ ] **Step 3: Implement.**
  - The popstate listener records `e.hasUAVisualTransition === true` in a ref.
  - The slide effect consumes it once and skips the slide.
  - `withViewTransition` takes `{ skip: boolean }`.
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`. Dispatch `visual-update` on the branch if the
  compact baselines move.
- [ ] **Step 5:** Changeset `@capybara-hq/web: patch`. Commit `feat(design): platform-tuned
  transitions without double animation`.

### Task 8: Perceived speed (spec §7.3)

> **Note 2026-11-21 (done; not rewritten).** Task 28 drops `/me` from the skeleton route list when
> it deletes the page and adds `/`.

**Files:**
- Create: `apps/web/src/lib/query/warm.ts`.
- Modify: `components/design-root.tsx` (the `link` component calls `warmRoute` on `pointerdown`),
  `components/shell/conversations.tsx` (an IntersectionObserver warms a row's conversation when
  it scrolls into view, at most once per id).
- Test: `apps/web/test/warm-route.test.tsx` (new), `apps/web/test/compact-skeletons.test.tsx`
  (new).

**Interfaces:** Produces
`warmRoute(qc: QueryClient, href: string, ctx: RouteCtx): Promise<void>`. It runs `matchRoute`'s
entry `queries(ctx)` with `prefetchQuery({ retry: false })` and also `router.prefetch(href)`. It
does nothing for other origins, for unknown routes and when the entry needs a role the viewer
lacks.

- [ ] **Step 1: Failing tests.**
  - **warmRoute.** `pointerdown` on a link to `/chat/c1` prefetches the conversation query once (a
    second `pointerdown` within freshness fetches nothing). An external `href` and `/[...rest]`
    prefetch nothing. A row entering view prefetches once.
  - **Skeletons** (`renderRouteEmptyCache` at 390 px for `/conversations`, `/agents`, `/inbox`,
    `/me`, `/chat/c1`, `/skills`, `/connectors`, `/schedules`): the page's main region contains
    `[data-loading="true"]` or a template skeleton part, and its text content is never empty
    before data.
  - **Resume** (layout spec §7.6, already built): the existing `stream-resume` test stays green.
    Re-run it and do not add a duplicate.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/warm-route.test.tsx apps/web/test/compact-skeletons.test.tsx`
  — expect FAIL.
- [ ] **Step 3: Implement.** Any compact route that renders blank fails this test; fix it in its
  template's loading shape (design), never in the page.
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm typecheck`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: patch`. Commit `feat(web): warm routes on touch and
  check compact skeletons`.

### Task 9: Duo edge to edge on the web (spec §8) — amended 2026-11-21

> **Amended 2026-11-21** (not started when the amendment landed): the full-bleed parts are now the
> chat-first shell's (the floating row, the floating composer, the ActionRow, the page ground);
> the top bar and the bottom navigation it listed are retired, and the `[data-native-nav]` bottom
> padding case is gone (no native bottom bar). Runs after Tasks 27 and 30.

Depends on spike 1.4 only for the record. The CSS is the same either way, because
`--cb-inset-right` is `max(env(safe-area-inset-right), var(--cb-shell-inset-right, 0px))`.

**Files:** Modify `packages/design/src/styles/{shell,touch,templates,conversation-page}.css`. Test:
`packages/design/test/duo-edge.test.ts` (new), `apps/web/visual/duo.spec.ts` (new; baselines via
`visual-update`).

- [ ] **Step 1: Failing tests.**
  - `duo-edge.test.ts`: the full-bleed grounds have no `margin-right` / `right` offset by an
    inset: the page body, `.cb-action-row`, the floating composer's dock and the drawer's scrim.
  - Their inner content declares `padding-inline-end` (or `padding-right`) containing
    `var(--cb-inset-right)`; the floating row's trailing control is placed with `right` (or
    `inset-inline-end`) containing `var(--cb-inset-right)`.
  - No rule pads the shell's bottom by a native bar: under `[data-native-nav]` the bottom padding
    is `--cb-inset-bottom` alone (0 from the mobile shell).
- [ ] **Step 2:** Add `duo.spec.ts`. At 382 × 800 with a coarse pointer and
  `document.documentElement.style.setProperty("--cb-shell-inset-right","84px")` (the spike's strip
  width), take screenshots `duo-outer-home` (`/`) and `duo-outer-chat` (`/chat/<fixture>`), once
  plain and once with `data-native-nav` on `<html>`. The ground runs to the right edge; text and
  controls end 84 px before it; with `data-native-nav` the web's menu button is absent.
- [ ] **Step 3: Run** `pnpm exec vitest run --project design packages/design/test/duo-edge.test.ts`
  — expect FAIL. Then implement, and run again — expect PASS.
- [ ] **Step 4:** Dispatch `visual-update` on the branch; review the four new baselines.
- [ ] **Step 5:** Changeset `@capybara-hq/web: patch`. Commit `feat(design): edge to edge under the
  Duo strip`.

## Phase 2b: touch and chat-first (core, added 2026-11-21)

Spec: layout spec §4.1–§4.6, §7, §8, §11 and mobile app spec §5.2, §6.1 as amended on
2026-11-21; the boards "Capybara 触屏版" (首页, 会话中, 抽屉, 收件箱, 对话设置, 浅色首页, 请在电脑上管理,
iPhone Duo 外屏 / 内屏) are the visual reference the reference blocks are drawn from. Every design
change goes through the design spec's change process (state lists, size tables, reference
blocks, `/dev/ui` catalog). Desktop output must not change: each design task re-runs the 1440
baselines and expects no diff.

### Task 23: SDK `nav@1` (strip shape) and `profiles@1`

Depends on PR #477 (Task 2) on main.

**Files:**
- Modify: `packages/plugin-sdk/src/shell-capabilities.ts` (append), `src/shell-environment.ts`
  (`SHELL_CAPABILITIES` rows `nav@1`, `profiles@1`, owner: mobile app spec §5.2),
  `src/index.ts`; regenerate `api/plugin-sdk.api.md`.
- Modify: `apps/web/src/lib/shell.ts` (mirror only, before `export const useDeviceCapability`).
- Modify: `tools/checks/src/terms.ts` if the terms guard needs the new `*CapabilityV1` names
  (as `fee76914f` did for Task 2).
- Create: `.changeset/sdk-nav-strip.md` (`"@capybara-hq/plugin-sdk": minor`).
- Test: `packages/plugin-sdk/test/shell-capabilities.test.ts`, `shell-environment.test.ts`.

**Interfaces:** Produces (exact; the push plan appends `push@1` after it):
```ts
// SHELL_CAPABILITY_KEYS gains: nav: "nav@1", profiles: "profiles@1"
export type NavSectionId = "chats" | "inbox" | "agents" | "schedules";
export const NAV_SECTION_ORDER: readonly NavSectionId[] = ["chats", "inbox", "agents", "schedules"];
export interface NavBadgeV1 { count?: number; countMore?: boolean }
export interface NavItemV1 extends NavBadgeV1 { id: NavSectionId; label: string }
export interface NavMenuV1 extends NavBadgeV1 { label: string }
export interface NavStateV1 {
  /** The sections the person sees, in NAV_SECTION_ORDER (a guest has no `schedules`). */
  items: NavItemV1[];
  current: NavSectionId | null;
  /** The strip's menu button, or null for none (non-null while the web's class is compact). */
  menu: NavMenuV1 | null;
}
/** Offered only while the window has a strip (mobile app spec §6.1): presence is visibility. */
export interface NavCapabilityV1 {
  set(state: NavStateV1): Promise<void>;
  onSelect(listener: (id: NavSectionId) => void): () => void;
  onMenu(listener: () => void): () => void;
}
export interface ProfilesCapabilityV1 {
  /** Opens the native profile switcher; resolves when it closes, with nothing. */
  show(): Promise<void>;
}
```
`MOBILE_SHELL_LIMITS` is unchanged: `navLabel` (32) bounds the menu label too, `navCount` (9999)
its count.

- [ ] **Step 1: Failing tests.**
  - `SHELL_CAPABILITY_KEYS` toEqual main's keys plus `nav@1` and `profiles@1`.
  - Both new keys appear in `SHELL_CAPABILITIES`, owners naming the mobile app spec.
  - `expectTypeOf<NavSectionId>().toEqualTypeOf<"chats" | "inbox" | "agents" | "schedules">()`.
  - `expectTypeOf<keyof NavStateV1>().toEqualTypeOf<"items" | "current" | "menu">()` (no
    `visible`).
  - `expectTypeOf<ReturnType<NavCapabilityV1["onMenu"]>>().toEqualTypeOf<() => void>()`.
  - `expectTypeOf<ReturnType<ProfilesCapabilityV1["show"]>>().toEqualTypeOf<Promise<void>>()`.
  - `NAV_SECTION_ORDER` toEqual `["chats", "inbox", "agents", "schedules"]`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/shell-capabilities.test.ts packages/plugin-sdk/test/shell-environment.test.ts`
  — expect FAIL.
- [ ] **Step 3: Implement**, and copy the block into the `lib/shell.ts` mirror.
- [ ] **Step 4: Run** the tests and `apps/web/test/shell-types-mirror.test.ts` — expect PASS. Then
  `pnpm gen:sdk-api && pnpm check:sdk-api && pnpm check:sdk-api-changeset && pnpm check && pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(sdk): nav@1 strip sections and profiles@1`. After merge, the
  Version Packages PR publishes the SDK that Tasks 31 and 32 pin.

### Task 24: Touch tokens and font roles

**Files:**
- Modify: `docs/design/tokens.json` (a `touch` block and the new tokens below),
  `tools/checks/src/cli/gen-tokens.ts` and the tokens generator it calls (emit the block inside
  `@media <TOUCH_QUERY>` after the scheme blocks), the `check:tokens` rules (override names must
  exist; touch type sizes ≥ 13; touch contrast pairs).
- Generated: `packages/design/src/styles/tokens.css`, `packages/design/src/tokens.ts`.
- Create: `packages/design/src/shell/touch.ts` (`TOUCH_QUERY`, `useTouch()`); `isTouchPointer` in
  `shell/pointer.ts` reads the same constants.
- Modify: the design CSS that draws code, commands, paths, versions and times uses
  `var(--cb-font-code)`: `base.css` (`code`, `pre`, `kbd`, `samp`), the `DateTime`, version label,
  `KeycapCommand`, `CopyField`, tool row command, diff block and path cells (the audit list lives in
  the test, one selector each).
- Modify: `docs/design/spec.md` §2.2 (a touch column for the type table; the font roles: the UI
  font on touch, `font-code`), §2.5 (a touch column for the size scales, the radius steps), §2.6
  (icon sizes on touch), §4.3 (hit targets 44 on touch).
- Test: `packages/design/test/tokens.test.ts`, `spec-tables.test.ts`,
  `packages/design/test/touch-tokens.test.ts` (new), the tokens check's tests with red fixtures
  (`tools/checks/fixtures/tokens/…`: an override of an unknown token, a touch type size of 12).

**Interfaces:** Produces:
- New tokens, every scope: `font-code` (the Sarasa Mono SC stack), `radius-pill` (999),
  `float-ground` (dark `rgba(28,28,26,0.85)`, light `rgba(255,255,255,0.85)`), `float-line` (dark
  `rgba(255,255,255,0.08)`, light `rgba(26,26,24,0.08)`), `shadow-float-touch` (dark
  `0 6px 20px rgba(0,0,0,.35)`, light `0 6px 20px rgba(26,26,24,.10)`), `layout.drawer` (320),
  and the sizes `touch-hit` 44, `touch-float` 48, `touch-primary` 48, `touch-prominent` 52,
  `touch-composer` 60, `touch-row` 52, `touch-row-roomy` 56, `touch-icon` 22,
  `touch-icon-float` 24.
- Overrides under `TOUCH_QUERY`: `font` and `font-prose` → `system-ui, -apple-system,
  'PingFang SC', 'Noto Sans SC', sans-serif`; type size / line: `body` 17/24, `small` 15/20,
  `micro` 13/18, `h2` 22/28, `h1` 28/34, `prose` 17/26, `prose-small` 15/22, `metric` 22/28;
  `control-dense` and `control-default` 44, `control-prominent` 52; `row-dense` and
  `row-default` 44, `row-roomy` 56; `radius-sm` 12, `radius-md` 20, `radius-bubble` 20.
- Contrast pairs added: `ink` and `muted` on `float-ground` (composited over `bg`), both schemes.
- `export const TOUCH_QUERY = "(pointer: coarse), (any-pointer: coarse) and (not (any-pointer: fine))";`
  `export function useTouch(): boolean | null;` (`null` on the server and during hydration).

- [ ] **Step 1: Failing tests.**
  - `touch-tokens.test.ts` (on `parseCss` of `tokens.css`): exactly one `@media` block whose
    query equals `TOUCH_QUERY`, holding the overrides above and nothing else; every declaration
    outside it that existed before the task is unchanged (a snapshot of the pre-task `:root`
    declarations, checked in with the test); the new tokens exist in both schemes.
  - The font audit: each listed selector declares `font-family: var(--cb-font-code)`; no rule
    outside that list and `fonts.css` names Sarasa directly.
  - `useTouch()` is `null` before hydration and follows a fake `matchMedia` after;
    `isTouchPointer()` agrees with it for the four pointer combinations.
  - `tokens.test.ts` / `spec-tables.test.ts` see the new tokens and the touch columns.
  - The tokens check: the two red fixtures fail with their rule; the real file passes.
  - `design-breakpoint` accepts the touch query and still rejects a stray `max-width: 500px`.
- [ ] **Step 2: Run** `pnpm exec vitest run --project design packages/design/test/touch-tokens.test.ts packages/design/test/tokens.test.ts packages/design/test/spec-tables.test.ts`
  and the tokens check's tests — expect FAIL.
- [ ] **Step 3: Implement**, `pnpm gen:tokens`.
- [ ] **Step 4: Run** the tests, `pnpm check:tokens`, `pnpm check:web-ui`, `pnpm typecheck`.
  Dispatch `visual-update`: compact baselines move, the 1440 baselines must not.
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor`. Commit `feat(design): touch tokens and the
  code font role`.

### Task 25: Touch components: floating button, drawer, rows, bottom sheet

**Files:**
- Create: `packages/design/src/shell/floating-button.tsx` (`FloatingIconButton`),
  `src/overlays/drawer.tsx` (`Drawer`, `DrawerLevel`), `src/display/nav-row.tsx` (`NavRow`),
  `src/styles/touch.css` (floating surfaces; imported into `layer(design)` in `styles/index.css`),
  `src/overlays/use-overlay-history.ts` (`useOverlayHistory(open, close)`, Decision 25).
- Modify: `src/overlays/bottom-sheet.tsx` and `styles/overlays.css` (the touch form: radius
  `radius-md` at the top, the handle, rows `touch-row`), `styles/display.css` (ObjectRow and
  ItemList rows on touch: `touch-row` / `touch-row-roomy`, no `line-soft` dividers, no `line-card`
  box around the list), the index exports, `/dev/ui` catalog entries.
- Modify: `docs/design/spec.md` §6.7 (sheet touch form), §6.17 / §6.33 (touch rows), new §6.50
  FloatingIconButton, §6.51 Drawer, §6.52 NavRow (state lists, size tables, reference blocks from
  the 抽屉 and 收件箱 boards).
- Test: `packages/design/test/floating-button.test.tsx`, `drawer.test.tsx`, `nav-row.test.tsx`,
  `touch-rows.test.ts` (new), `bottom-sheet.test.tsx` (extend); `findNestedBoxes` stays clean.

**Interfaces:** Produces:
```ts
export interface NavBadge { count: number; more?: boolean }
export function badgeText(b: NavBadge | undefined): string | null; // 0 → null, 120 → "99+", 3+more → "3+"
export function FloatingIconButton(props: { icon: IconName; label: string; badge?: NavBadge;
  onClick?(): void; href?: string; "data-cap-part"?: string }): JSX.Element;
export function Drawer(props: { open: boolean; onOpenChange(open: boolean): void; label: string;
  children: ReactNode }): JSX.Element;
export function DrawerLevel(props: { title: string; backLabel: string; onBack(): void;
  children: ReactNode }): JSX.Element;
export function NavRow(props: { icon?: IconName; label: string; href?: string; onSelect?(): void;
  badge?: NavBadge; current?: boolean; trailing?: "chevron"; "data-nav-section"?: string }): JSX.Element;
```

- [ ] **Step 1: Failing tests.**
  - **FloatingIconButton**: `.cb-float-btn` sizes from `--cb-touch-float` under the touch query
    and from `--cb-control-prominent` otherwise; its ground, hairline and shadow are the float
    tokens; the badge renders `badgeText`; the accessible name is `label`; an `href` renders a
    link through the design `link` component.
  - **Drawer**: `role="dialog"`, `aria-modal`, `aria-label`; opening moves focus to the first
    row and Escape, the scrim and a pick close it with focus back on the trigger; a drag toward
    the start edge past 40 % (the `overlays/drag.ts` helper, fake pointer events) closes it, a
    short drag springs back; under reduced motion it snaps; no pointer listener exists on the
    screen edge while closed; a `DrawerLevel` replaces the list and its back row returns.
  - **Touch rows** (`parseCss`): under the touch query ObjectRow / ItemList rows have
    `min-height: var(--cb-touch-row)` (two-line `--cb-touch-row-roomy`) and no `border-bottom`,
    their list container no `box-shadow` hairline; outside it the desktop rules are unchanged.
  - **Bottom sheet**: under the touch query the sheet's top corners use `--cb-radius-md` and its
    option rows `--cb-touch-row`; the drag behaviour is unchanged.
  - **Back closes the overlay first** (`useOverlayHistory`, Decision 25; jsdom `history`):
    opening a `Drawer` or a touch `BottomSheet` adds exactly one history entry carrying the
    marker; a `popstate` back to the entry without the marker calls `onOpenChange(false)`;
    closing by scrim, drag, pick or Escape calls `history.back()` once (no second entry, no
    double close); two overlays open at once (a sheet over the drawer) hold two entries and back
    closes the top one; outside the compact touch query (medium, expanded, pointer fine) the hook
    pushes nothing; unmounting while open pops its entry.
- [ ] **Step 2: Run** `pnpm exec vitest run --project design packages/design/test/floating-button.test.tsx packages/design/test/drawer.test.tsx packages/design/test/nav-row.test.tsx packages/design/test/touch-rows.test.ts packages/design/test/bottom-sheet.test.tsx`
  — expect FAIL.
- [ ] **Step 3: Implement** in design only.
- [ ] **Step 4: Run** the tests, the design suite, `pnpm check:web-ui`. Dispatch `visual-update`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor`. Commit `feat(design): floating button,
  drawer and touch rows`.

### Task 26: Touch components: the conversation

**Files:**
- Modify: `packages/design/src/conversation/composer.tsx` (the touch pill: attach, input,
  send as a 48 accent circle, stop while running; no voice button, Decision 24),
  `composer-options.tsx` (the settings chip "model · thinking · device" above the pill and the
  settings sheet: model, thinking 低 / 中 / 高 as a `Segmented`, where to run, permissions, the note
  「设置只对这次会话生效。」), `bubble.tsx` (user bubble at the end edge), `hitl.tsx` (approval card
  buttons side by side at `touch-primary`, 拒绝 then 批准, 批准 the accent; the command in
  `font-code`), `tool-group.tsx` (the one-line summary on touch).
- Modify: `styles/conversation.css`, `styles/conversation-page.css` (the floating composer above
  `--cb-inset-bottom` and `--cb-keyboard-inset`; the thread's bottom padding clears it).
- Modify: `docs/design/spec.md` §6.16.2, §6.16.6, §6.16.8, §6.16.11 (touch forms; reference blocks
  from the 首页, 会话中 and 对话设置 boards); apps/web messages only if a new string is needed (none
  expected: the sheet reuses the composer options' strings).
- Test: `packages/design/test/touch-conversation.test.tsx` (new), `composer-menu.test.tsx`
  (extend).

- [ ] **Step 1: Failing tests.**
  - Under the touch query: the composer pill `min-height: var(--cb-touch-composer)` with
    `border-radius: var(--cb-radius-pill)`; send `var(--cb-touch-float)` round on `accent`;
    approval buttons `min-height: var(--cb-touch-primary)`; the user bubble sits at the end
    edge (`margin-inline-start: auto` or `justify-self: end`).
  - The pill holds exactly attach, the input and send (stop while running): no voice button and
    no `voice` prop exist.
  - The chip opens the settings sheet; picking 高 calls `onChange` once and plays `selection`; the
    sheet shows the note.
  - The approval card renders 拒绝 before 批准, 批准 primary, and its command in a
    `font-code` element.
  - Outside the touch query the composer and the thread match the existing snapshots.
- [ ] **Step 2: Run** `pnpm exec vitest run --project design packages/design/test/touch-conversation.test.tsx packages/design/test/composer-menu.test.tsx`
  — expect FAIL.
- [ ] **Step 3: Implement** in design only.
- [ ] **Step 4: Run** the tests, the design suite, `pnpm check:web-ui`. Dispatch `visual-update`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor`. Commit `feat(design): touch conversation
  layout`.

### Task 27: Chat-first compact shell (design)

**Files:**
- Create: `packages/design/src/shell/nav-drawer.tsx` (`NavDrawer`: search, sections, the
  「技能、连接器、设备…」 level, the recent list reusing `sidebar-conversations.tsx`, the foot),
  `src/shell/account-sheet.tsx` (`AccountSheet`), `src/shell/floating-bar.tsx` (the leading
  floating control: menu or back).
- Modify: `src/shell/app-shell.tsx` (compact frame: no top bar row, no bottom-nav slot; the
  leading floating control; `drawer` and `chatSurface` props; back without history → the last
  linked path segment, else `/`), `src/shell/view-transition.ts` and the slide effect (chat
  surface ↔ chat surface never slides; a push slides), `templates/conversation-page.tsx` and the
  title bar (its compact form is the floating centre pill and trailing overflow),
  `src/shell/page-header.tsx` (on compact the title sits below the floating row),
  `styles/shell.css`, `styles/touch.css`.
- The drawer and the account sheet use Task 25's overlay history, so back closes them first
  (Decision 25); the home's trailing floating slot stays empty (no 无痕会话 button, Decision 27).
- The AppShell stops rendering `BottomNav` and `TopBar`; the modules `bottom-nav.tsx`,
  `top-bar.tsx` and `me-panel.tsx` and their exports stay untouched in this task, because apps/web
  still imports `BottomNavItem` and `MePanel` (Task 28 deletes them with their last users).
- Modify: `packages/design/test/touch.test.ts` (Task 6's audit lists gain `.cb-float-btn`, the
  drawer's rows and the account sheet's rows).
- Modify: `docs/design/spec.md` §4.6 (rewritten: chat surfaces, pushed pages, floating controls,
  the drawer), §4.7; new §6.53 NavDrawer, §6.54 AccountSheet, §6.55 FloatingBar; §5.4 / §6.16.1
  compact title bar (Task 28 removes §6.45, §6.46 and §6.48).
- Test: `packages/design/test/compact-shell.test.tsx` (new or reworked), `nav-drawer.test.tsx`,
  `account-sheet.test.tsx`, `transitions.test.tsx` (re-keyed), `shell.test.tsx`.

**Interfaces:** Produces:
```ts
export type DrawerSectionId = "inbox" | "agents" | "schedules";
export interface DrawerNavData {
  sections: { id: DrawerSectionId; label: string; href: string; icon: IconName; badge?: NavBadge }[];
  more: { id: string; label: string; href: string; icon: IconName }[]; // 技能, 连接器, 设备, org pages
  moreLabel: string;                       // 「技能、连接器、设备…」
  recent: SidebarConversationsProps;       // the sidebar's conversation section
  allConversations: { label: string; href: string };
  newConversation: { label: string; href: string };
  onSearch(): void;                        // opens the command palette
  account: AccountSheetData;
  menuBadge?: NavBadge;                    // the pending inbox count on the menu button
}
export interface AccountSheetData {
  name: string; orgName: string | null; avatar?: AvatarProps;
  orgSwitcher?: ReactNode; personalSettingsHref: string; theme: ReactNode; status: ReactNode;
  installHint?: ReactNode; onSwitchProfile?(): void; onSignOut(): void;
}
// AppShellProps: + drawer?: DrawerNavData; + chatSurface?: boolean; − bottomNav
```
The leading control is the shell's; the centre and trailing floating controls belong to the
templates (ConversationPage's title bar, the page head's actions).

- [ ] **Step 1: Failing tests.**
  - At compact on a chat surface: a menu button with the badge, no back, no `.cb-shell-bottomnav`,
    no top bar element. On a pushed page: a back button and no menu button.
  - Back with history pops; without history goes to the last linked path segment; with no
    linked segment goes to `/`.
  - The menu button opens the drawer: sections in order with the inbox badge (a guest's data
    without `schedules` renders two), the more row opens its level with the `more` entries, the
    recent list and 「全部会话」, the foot's account row and new conversation; a pick closes the
    drawer and navigates.
  - The account row opens `AccountSheet` with the org switcher, 个人设置, theme, status, sign
    out; 「切换平台」 only with `onSwitchProfile`.
  - Chat surface → chat surface sets no `data-nav`; chat surface → pushed sets `data-nav="push-*"`;
    a `hasUAVisualTransition` pop still skips (Task 7).
  - Back closes overlays first: with the drawer open, a `popstate` closes it and the route stays;
    with the account sheet open over the drawer, the first back closes the sheet, the second the
    drawer, the third navigates.
  - The home renders no trailing floating control (no incognito button).
  - Medium and expanded render as before (the sidebar and rail tests stay green).
  - `findNestedBoxes` finds nothing in the drawer or the account sheet.
- [ ] **Step 2: Run** `pnpm exec vitest run --project design packages/design/test/compact-shell.test.tsx packages/design/test/nav-drawer.test.tsx packages/design/test/account-sheet.test.tsx packages/design/test/transitions.test.tsx packages/design/test/touch.test.ts`
  — expect FAIL.
- [ ] **Step 3: Implement.** apps/web still passes `bottomNav` until Task 28: keep the prop
  accepted and ignored for this one task; Task 28 removes it.
- [ ] **Step 4: Run** the tests, the design suite, `pnpm check:web-ui`, `pnpm typecheck`.
  Dispatch `visual-update`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor`. Commit `feat(design): chat-first compact
  shell`.

### Task 28: Chat-first wiring in apps/web; `/me` retired

**Files:**
- Modify: `apps/web/src/components/shell/nav.tsx` (`useDrawerNav()` from the same `NAV` data:
  sections inbox / agents / schedules by audience, `more` = skills / connectors / devices plus the
  org's extension pages; the management items never enter it; `useNav`'s bottom-nav output
  removed), `components/shell/AppFrame.tsx` (pass `drawer` and `chatSurface`, drop `bottomNav`),
  `lib/chat-surface.ts` (new: `isChatSurface(pathname)`), `app/manifest.ts`
  (`start_url: "/"`), `lib/query/routes.ts` (drop `/me`), `components/shell/path.ts`,
  `apps/web/messages/{zh,en}.json` (drawer and account sheet strings; the `me.*` keys removed).
- Delete: `app/(app)/me/`, `components/shell/me.tsx`, `apps/web/test/me-page.test.tsx`; in
  design, `src/shell/bottom-nav.tsx`, `top-bar.tsx`, `me-panel.tsx`, their CSS, exports, `/dev/ui`
  entries and tests (`bottom-nav.test.tsx`, `top-bar.test.tsx`, `me-panel.test.tsx`), and in
  `packages/design/test/touch.test.ts` the audit entries `.cb-bottomnav a` and
  `.cb-shell-topbar`.
- Modify tests: `apps/web/test/compact-shell.test.tsx`, `compact-shell-catalog.test.tsx`,
  `compact-skeletons.test.tsx` (drop `/me`, add `/`), `manifest.test.ts`, `nav.test.tsx`.
- Remove the ignored `bottomNav` prop from design's `AppShellProps` (Task 27 Step 3).
- Modify: `docs/design/spec.md`: remove §6.45 BottomNav, §6.46 TopBar and §6.48 MePanel (Task 27
  wrote their replacements).

- [ ] **Step 1: Failing tests.**
  - `isChatSurface`: `/` and `/chat/c1` true; `/conversations`, `/inbox`, `/agents`,
    `/chat` (redirect) false.
  - `useDrawerNav` for a member: sections inbox (count from `inboxCountQuery`), agents,
    schedules; `more` holds skills, connectors, devices and an `org.page`; nothing for plugins,
    extensions, channels, evals or settings. A guest: no schedules, no skills.
  - AppFrame at compact renders the menu button with the inbox badge and passes
    `chatSurface` from the pathname.
  - `/me` is not in the route table and renders the not-found page.
  - On the home no trailing control renders; with the drawer open, `history.back()` closes it
    without a route change, and a route change made by a drawer pick leaves no stale overlay
    entry (the pick pops its entry before navigating, so one back goes to the previous page).
  - The conversation settings sheet and the account sheet (Task 27) behave the same: open
    pushes one entry, back closes it.
  - The manifest's `start_url` is `/`.
  - `check:i18n` passes with the `me.*` keys gone (no orphan, no missing key).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/compact-shell.test.tsx apps/web/test/compact-skeletons.test.tsx apps/web/test/manifest.test.ts apps/web/test/nav.test.tsx`
  — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm typecheck`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor`. Commit `feat(web): chat-first compact
  navigation; retire the Me page`.

### Task 29: The 「请在电脑上管理」 page and the touch route gate

**Files:**
- Create: `packages/design/src/templates/desktop-only.tsx` (`DesktopOnlyNotice`, a `StatusPage`
  form: title, sentence, the URL in `font-code`, 复制链接, 回到对话 as the primary).
- Modify: `src/shell/app-shell.tsx` (prop `desktopOnly`: renders the notice and the children on
  the server; after hydration `useTouch() === true` mounts only the notice, `false` only the
  children), `styles/templates.css` (the notice shown and the page hidden under `TOUCH_QUERY`, the
  reverse otherwise), the sidebar, rail and command palette (an entry flagged `desktopOnly`
  carries `data-desktop-only`, hidden under `TOUCH_QUERY`).
- Modify: `apps/web/src/lib/query/routes.ts` (`desktopOnly: true` on every route under the
  Values prefixes), `components/shell/AppFrame.tsx` (pass `desktopOnly` from `matchRoute`, the URL
  from `location.href` after hydration and the pathname before, `onCopy` through the existing
  copy helper and toast), `components/shell/nav.tsx` (the management items flagged),
  `apps/web/messages/{zh,en}.json` (`desktopOnly.title` 「请在电脑上管理」 / "Manage this on a
  computer", `desktopOnly.body` 「插件、扩展、渠道、组织设置和管理后台这类配置，只在电脑上提供。」 / "Plugins,
  extensions, channels, organization settings and the admin console are managed on a computer.",
  `desktopOnly.copy` 「复制链接」 / "Copy link", `desktopOnly.copied`, `desktopOnly.back` 「回到对话」 /
  "Back to chat").
- Modify: `docs/design/spec.md` (the notice in §5.10 / StatusPage forms, with its reference
  block from the 请在电脑上管理 board).
- Test: `packages/design/test/desktop-only.test.tsx` (new), `apps/web/test/desktop-only-routes.test.ts`
  (new), `apps/web/test/compact-shell.test.tsx` (extend).

- [ ] **Step 1: Failing tests.**
  - Design: the server render holds the notice and the children; the CSS shows the notice only
    under `TOUCH_QUERY` (`parseCss`); after hydration with a coarse `matchMedia` the children are
    not in the DOM and a child's effect never ran; with a fine one the notice is not in the DOM;
    复制链接 calls `onCopy`; 回到对话 links to `/`.
  - Web: every route under the seven prefixes has `desktopOnly`; `/`, `/chat/c1`,
    `/conversations`, `/inbox`, `/agents`, `/schedules`, `/skills`, `/connectors`, `/devices`,
    `/p/x/y` and every `/account/*` route do not; the sidebar's 插件 / 扩展 / 渠道 / 评测与运行 /
    组织设置 / 管理后台 entries and their palette commands carry `data-desktop-only`; the drawer has
    none of them; on touch at `/settings/members` no request for the members query is made.
- [ ] **Step 2: Run** `pnpm exec vitest run --project design packages/design/test/desktop-only.test.tsx`
  and `pnpm exec vitest run apps/web/test/desktop-only-routes.test.ts apps/web/test/compact-shell.test.tsx`
  — expect FAIL.
- [ ] **Step 3: Implement.** Not access control: the kernel's answers are unchanged.
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm typecheck`.
  Dispatch `visual-update` (one compact baseline of the notice, dark and light).
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor`. Commit `feat(web,design): management pages
  are desktop-only on touch`.

### Task 30: `nav@1` strip rework of the native handles; `profiles@1` in the web

Replaces the `nativeNav` parts of Tasks 4 and 5 (see their notes); everything else they built
stays.

**Files:**
- Modify: `packages/design/src/native.ts` (`NativeSectionId`, the new `NativeNavHandle`; drop
  `NativeTabId`), `src/shell/app-shell.tsx` (send `set` from the drawer data and the route; `menu`
  non-null while the hydrated class is compact; `onSelect` → `selection` haptic and
  `onNavigate(href, { transition: "none" })`; `onMenu` toggles the drawer; when the handle goes,
  clear `data-native-nav` on the shell element and on `<html>`; no hide-on-unmount call), the
  drawer, rail and sidebar (section entries carry `data-nav-section`; the account popover's
  `more` group shows only under `[data-native-nav]`), `styles/shell.css` (remove
  `[data-native-nav] .cb-shell-bottomnav`; add `[data-native-nav] [data-nav-section]` and
  `[data-native-nav] .cb-shell-menu-btn` hidden; on medium and expanded also the sidebar's other
  section entries, layout spec §4.3).
- Modify: `apps/web/src/lib/shell.ts` (`useNavCapability`, `useNativeNavHandle` in the new shape,
  `useProfilesCapability`, `useSwitchProfile()`), `components/shell/AppFrame.tsx` (`nativeNav`,
  `onSwitchProfile`), `components/shell/nav.tsx` (the section items with their `NavSectionId`).
- Test: `packages/design/test/native-nav.test.tsx` (rewritten for the new shape),
  `apps/web/test/shell-adapter.test.tsx`, `apps/web/test/native-wiring.test.tsx`.

**Interfaces:**
- Consumes: Task 23's types (mirror); Task 27's `DrawerNavData`, `AccountSheetData`.
- Produces:
  ```ts
  export type NativeSectionId = "chats" | "inbox" | "agents" | "schedules";
  export interface NativeNavHandle {
    set(state: { items: { id: NativeSectionId; label: string; count?: number; countMore?: boolean }[];
                 current: NativeSectionId | null;
                 menu: { label: string; count?: number; countMore?: boolean } | null }): void;
    onSelect(listener: (id: NativeSectionId) => void): () => void;
    onMenu(listener: () => void): () => void;
  }
  // apps/web lib/shell.ts
  export const useProfilesCapability: () => ProfilesCapabilityV1 | undefined;
  export function useSwitchProfile(): (() => void) | undefined; // calls show() inside the click
  ```

- [ ] **Step 1: Failing tests.**
  - Design, a fake `nativeNav` at compact on `/`: the shell has `data-native-nav`; `set` once
    with `chats`, `inbox` (count 3), `agents`, `schedules`, `current: "chats"`, `menu` with the
    label and count 3; the web's menu button and the drawer's section rows are hidden by the CSS
    (`parseCss`); a medium width sends `menu: null`; a guest's items omit `schedules`; `/inbox`
    sends `current: "inbox"`, `/account/preferences` `current: null`; an unchanged rerender and a
    new equivalent handle each render send nothing (Task 4's guard).
  - `onSelect("agents")` → `haptics("selection")` and `onNavigate("/agents", { transition:
    "none" })`, no `data-nav`; `onSelect` of the current section navigates to its root.
  - `onMenu` opens the drawer, a second `onMenu` closes it.
  - The handle going away (a `change` that removes `nav@1`) removes `data-native-nav` from the
    shell element and `<html>` and shows the web's menu button and section rows again; unmount
    unsubscribes both listeners and calls nothing else.
  - Web: `useNativeNavHandle` is undefined without `nav@1`; a rejected `set` is swallowed;
    AppFrame passes `nativeNav` only with `nav@1`; 「切换平台」 shows only with `profiles@1`, and
    tapping it calls `show()` synchronously in the click handler.
- [ ] **Step 2: Run** `pnpm exec vitest run --project design packages/design/test/native-nav.test.tsx`
  and `pnpm exec vitest run apps/web/test/shell-adapter.test.tsx apps/web/test/native-wiring.test.tsx apps/web/test/shell-types-mirror.test.ts`
  — expect FAIL.
- [ ] **Step 3: Implement.** `nav.set` is the one capability call made from an effect (not
  confirming, no activation; Task 5's rule).
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui` (incl. `web-shell-access`), `pnpm typecheck`.
- [ ] **Step 5:** Changeset `@capybara-hq/web: minor`. Commit `feat(web,design): nav@1 strip
  sections and the profile switcher`.

## Phase 3: the app shell (clients)

Commands (from the clients repo root):
- `pnpm exec vitest run <path>`.
- iOS: `pnpm --filter @capybara-hq/mobile test:ios` (XCTest) and `test:ios:ui` (XCUITest).
- Android: `pnpm --filter @capybara-hq/mobile test:android` (JUnit) and
  `test:android:device` (instrumented).
- `pnpm lint && pnpm typecheck && pnpm check:i18n`.

### Task 10: `packages/shell` lifts

**Files:**
- Modify: `packages/shell/src/pkce.ts` (add the Web Crypto variant), `meta.ts` (`readCapped` with
  `TextDecoder`, no `Buffer`).
- Create:
  - `src/sign-in-guard.ts` (moved from `apps/desktop/src/main/request-guard.ts`: `isInWindowSignIn`,
    `canonicalPath`; plus `signInBlockRules`);
  - `src/validate.ts` (moved `sameOriginUrl`, `isBackgroundColor`, `isRecord`);
  - `src/install-shell.ts` (moved `installShellEnvironment` with `kind` in the init).
- Create: `test/fixtures/in-window-sign-in.json`.
- Modify: the desktop imports; `i18n/{zh,en}.json` (mobile keys: profile switcher, single-store
  confirm, error state, `address.error.sign_in_unavailable_mobile`).
- Test: `packages/shell/test/{pkce,meta,sign-in-guard,validate,install-shell}.test.ts`; the
  existing desktop tests stay green.

**Interfaces:** Produces:
```ts
export function createPkceWeb(random?: (n: number) => Uint8Array): Promise<{ verifier: string; challenge: string }>;
export function isInWindowSignIn(method: string, url: string, base: string): boolean;
/** WebKit content-blocker rules (no `|`, case-insensitive by default) that block the two routes. */
export function signInBlockRules(base: string): { trigger: { "url-filter": string }; action: { type: "block" } }[];
export function sameOriginUrl(path: string, origin: string): string | null;
export function isBackgroundColor(v: string): boolean;
export function installShellEnvironment(init: ShellInit & { kind: "desktop" | "mobile" }, bridge: ShellBridge, target?: object): void;
```
The vector file holds `[{ method, url, base, blocked }]`. Include every case of the desktop's
`request-guard.test.ts`, plus `%6cogin`, `//api//v1`, upper case, a trailing slash, base prefix
`/cap`, another origin and a query string.

- [ ] **Step 1: Failing tests.**
  - `createPkceWeb` with RFC 7636 Appendix B bytes → challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`.
  - `fetchMeta` works with a `fetch` whose body is a web `ReadableStream`, without `Buffer` in
    scope (`vi.stubGlobal("Buffer", undefined)`).
  - **Vectors.** Every entry of the vector file: `isInWindowSignIn` equals `blocked`. A JS
    emulation of `signInBlockRules` (each `url-filter` compiled with flag `i` and tested against
    the URL the WebView would request) blocks exactly the `blocked` GET / POST entries, except
    the method-only cases marked `"iosBlocksAnyMethod": true`.
  - `installShellEnvironment({ kind: "mobile", … })` defines a frozen global with `kind: "mobile"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/shell` — expect FAIL.
- [ ] **Step 3: Implement.** Make the moves with re-exports from the old desktop paths removed, and
  update the desktop imports.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && pnpm check:i18n && pnpm lint`.
- [ ] **Step 5:** Changesets `@capybara-hq/shell: minor`, `@capybara-hq/desktop: patch`. Commit
  `refactor(shell): share sign-in guard, validators and the installer with mobile`.

### Task 11: Scaffold `apps/mobile` and CI

Depends on Task 1.5's ruling. With "plain native shells", Capacitor's projects are replaced by
plain Xcode / Gradle projects hosting a local runtime WebView. The paths below stay; the native
`HostPort` implementation changes.

**Files:**
- Create: `apps/mobile/package.json` (`@capybara-hq/mobile`, private; scripts `build` (esbuild:
  `src/local/**` and `src/inject/shell-environment.ts` → IIFE), `sync`, `test:ios`,
  `test:ios:ui`, `test:android`, `test:android:device`, `check:brand`).
- Create: `capacitor.config.ts` (`appId` / `appName` from `brand.ts`; `webDir: "dist/local"`;
  `server` unset: no remote URL in Capacitor's WebView), `tsconfig.json`, `ios/`,
  `android/` (`npx cap add`), `scripts/ios-test.sh` (picks an available iOS 27.1 simulator).
- Create: `.changeset/mobile-scaffold.md` (`@capybara-hq/mobile: minor`).
- Modify: root `tsconfig.json`, `vitest.config.ts`, `pnpm-workspace.yaml`, `AGENTS.md` (map row).
- Modify: `.github/workflows/ci.yml`. Add `mobile-ios` (macos-latest, Xcode 27.1, `test:ios`
  and `test:ios:ui`) and `mobile-android` (ubuntu-latest, JDK 21, `test:android`, then
  `test:android:device` on an emulator action pinned by SHA). Both join `ci-ok`.
- Test: `apps/mobile/test/scaffold.test.ts`.

- [ ] **Step 1: Failing test.**
  - `capacitor.config.ts` has no `server.url` and no `server.allowNavigation`.
  - `bundledWebRuntime` is unset.
  - The iOS deployment target in `project.pbxproj` is `17.0`.
  - Android `minSdk` equals Capacitor's default and `targetSdk` is the current Play requirement.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/scaffold.test.ts` — expect FAIL. Then
  scaffold.
- [ ] **Step 3: Run** the test, `pnpm --filter @capybara-hq/mobile build`,
  `npx cap sync`, `test:ios` and `test:android` (empty suites pass), `pnpm typecheck`,
  `pnpm lint`.
- [ ] **Step 4: Commit** `feat(mobile): scaffold the Capacitor app and its CI jobs`.

### Task 12: Brand file, generator, drift check

**Files:**
- Create: `apps/mobile/brand.ts`, `apps/mobile/assets/{icon.png,splash.png}`,
  `scripts/apply-brand.ts`, generated `ios/App/Brand.xcconfig`, `android/brand.properties`,
  `brand-assets.sha256`.
- Modify: `ios/App/App/Info.plist` (`CFBundleDisplayName = $(BRAND_NAME)`, the URL type
  `$(BRAND_SCHEME)`), the xcodeproj (`PRODUCT_BUNDLE_IDENTIFIER = $(BRAND_APP_ID)`, includes
  `Brand.xcconfig`), `android/app/build.gradle` (`applicationId`, manifest placeholder
  `brandScheme` read from `brand.properties`), `AndroidManifest.xml` (intent filter
  `${brandScheme}://auth`).
- Modify: `.github/workflows/ci.yml` (lint job runs `pnpm --filter @capybara-hq/mobile check:brand`).
- Test: `apps/mobile/test/brand.test.ts`.

**Interfaces:** Produces
```ts
export const brand: {
  productName: string;            // "Capybara"
  appId: string;                  // "com.capybarahq.mobile"
  scheme: string;                 // "capybara"
  icon: string;                   // "assets/icon.png", 1024 × 1024 PNG
  splash: { image: string; background: { light: string; dark: string } }; // ground tokens of core docs/design/tokens.json
  presetUrl: string | null;       // null
  lockToPreset: boolean;          // false
};
export function validateBrand(b: typeof brand): string[]; // problems, empty when valid
export function applyBrand(opts: { check: boolean }): Promise<{ drift: string[] }>;
```

- [ ] **Step 1: Failing tests.**
  - `validateBrand`: the official brand → `[]`.
  - It flags each of these: `appId: "capybara"` (not reverse DNS), `scheme: "https"`,
    `scheme: "Cap"`, `presetUrl: "http://x.example"`, `lockToPreset: true` with
    `presetUrl: null`, splash colours outside `#rrggbb`.
  - `applyBrand({ check: true })` on a temp copy where `Brand.xcconfig` says another id → `drift`
    names that file. An icon changed without regenerating → `drift` names `brand-assets.sha256`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/brand.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** The generator renders the icon sets with `@capacitor/assets` (exact
  pin) from `brand.icon` / `brand.splash`, writes the two config files and the hash, and in
  `--check` mode writes nothing and exits 1 on drift.
- [ ] **Step 4: Run** the test, `check:brand` (clean), an iOS and an Android debug build.
- [ ] **Step 5: Commit** `feat(mobile): brand file, generator and drift check`.

### Task 13: Runtime, injected script and the origin gate — high risk, review alone

Depends on spike 1.2 (the mechanism proven there is the one built here).

**Files:**
- Create:
  - `apps/mobile/src/runtime/{protocol,registry,dialog-gate,host-port}.ts`;
  - `src/inject/shell-environment.ts` (wraps `installShellEnvironment`: top frame and exact
    origin only, the user-activation check, the native post);
  - `ios/App/App/Shell/{OriginGate,ShellMessageHandler,ProfileWebView,ShellPlugin}.swift`;
  - `android/app/src/main/java/com/capybarahq/shell/{OriginGate,ShellMessageListener,ProfileWebView,ShellPlugin}.kt`;
  - `ShellPlugins.{swift,kt}` (registration list);
  - `apps/mobile/testpages/hostile/` (1.2's pages);
  - `ios/AppTests/OriginGateTests.swift`, `ios/AppUITests/HostilePageTests.swift`;
  - `android/app/src/test/.../OriginGateTest.kt`, `android/app/src/androidTest/.../HostilePageTest.kt`.
- Test: `apps/mobile/test/runtime/{registry,dialog-gate,inject}.test.ts`.

**Interfaces:** Produces:
```ts
// protocol.ts
export interface ShellCallMessage { profileId: string; origin: string; docId: string; callId: string;
  key: string; fn: string; args: unknown[]; activation: boolean }
export type ShellCallResult = { ok: true; value: unknown } | { ok: false; code: ShellCallError };
export interface CallContext { profile: Profile; origin: string; docId: string; activation: boolean }
// registry.ts
export interface CapabilityImpl {
  functions: Record<string, (ctx: CallContext, ...args: unknown[]) => Promise<unknown>>;
  events?: readonly string[];
  /** Need a user activation and the per-profile dialog gate (`busy`). */
  confirming?: readonly string[];
}
export interface CapabilityRegistry {
  register(key: string, impl: CapabilityImpl, opts?: { available?(profile: Profile): boolean }): void;
  descriptors(profile: Profile): { capabilities: Record<string, string[]>; events: Record<string, string[]> };
  dispatch(msg: ShellCallMessage): Promise<ShellCallResult>;
  emit(profileId: string, key: string, event: string, payload: unknown): void;
}
export function createRegistry(deps: { host: HostPort; profiles: ProfileStore }): CapabilityRegistry;
// host-port.ts: the TypeScript-facing native contract (a Capacitor plugin `CapybaraHost`)
export interface HostPort {
  onCall(listener: (msg: ShellCallMessage) => void): () => void;
  reply(profileId: string, callId: string, result: ShellCallResult): Promise<void>;
  pushState(profileId: string, state: ShellState): Promise<void>; // change event to the page
  event(profileId: string, key: string, event: string, payload: unknown): Promise<void>;
}
```
Native gates, pure and unit-tested:
- Swift: `enum OriginGate { static func accept(isMainFrame: Bool, scheme: String, host: String, port: Int, profileOrigin: URL) -> Bool }`.
- Kotlin: `object OriginGate { fun accept(isMainFrame: Boolean, sourceOrigin: Uri, profileOrigin: Uri): Boolean }`.

Exact origin means scheme, host and effective port; a default port is normalized.

- [ ] **Step 1: Failing tests.**
  - **Registry.**
    - `dispatch` with `origin` ≠ the profile's origin → `failed`, and the impl is never called.
    - An unknown key or function → `failed`.
    - A confirming function with `activation: false` → `no_activation`.
    - A second confirming call while the first is unresolved → `busy`; after it settles, the
      next call is accepted.
    - An impl throwing a non-`ShellCallError` → `failed`.
    - `available` false → the key is absent from `descriptors` and `dispatch` answers `failed`.
    - `emit` reaches `host.event` only for subscribed events.
  - **Inject** (jsdom):
    - In an iframe nothing is defined.
    - With `location.origin` ≠ `init.origin` nothing is defined.
    - In the top frame the global is frozen, `kind: "mobile"`, and the capability functions post
      `{ key, fn, args, activation }`, where `activation` reads `navigator.userActivation.isActive`.
    - `window.Capacitor` is never touched.
  - **XCTest / JUnit `OriginGate`:**
    - Rejected: a sub-frame on the same origin; `https://a.example` vs `https://a.example:444`;
      `http` vs `https`; a host differing only by a trailing dot; IDN host vs punycode not equal.
    - Accepted: `https://a.example:443` vs profile `https://a.example`.
  - **XCUITest / instrumented `hostile-page`:** 1.2's four documents and their pass criteria, run
    against the real `ProfileWebView`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/runtime`, `test:ios`, `test:android`
  — expect FAIL.
- [ ] **Step 3: Implement.**
  - iOS: `WKUserScript(forMainFrameOnly: true, .atDocumentStart)` built from the IIFE plus the init
    JSON (the descriptors of `registry.descriptors`). Calls use `WKScriptMessageHandlerWithReply`.
    Changes and events go through `evaluateJavaScript` into a closure the script registered (a page
    can only lie to itself there).
  - Android: `addDocumentStartJavaScript` and `addWebMessageListener` with the profile origin
    rule; replies go through `JavaScriptReplyProxy`.
  - The profile WebView is never Capacitor's `bridge.webView`, and no Capacitor plugin is
    reachable from it.
- [ ] **Step 4: Run** all of the above — expect PASS. Then `pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** `feat(mobile): runtime, shell environment script and the origin gate`.

### Task 14: Profiles and data stores

Depends on spike 1.3 for Android's mode.

**Files:** Create `apps/mobile/src/runtime/profiles.ts`, `ios/App/App/Shell/DataStores.swift`,
`android/.../DataStores.kt`, `ios/AppTests/DataStoresTests.swift`,
`android/app/src/test/.../DataStoresTest.kt`, `apps/mobile/test/runtime/profiles.test.ts`. Modify
`ShellPlugins.{swift,kt}` (one line, after Task 13).

**Interfaces:** Produces:
```ts
export interface Profile { id: string; base: string; origin: string; name: string | null;
  iconUrl: string | null; dataStoreId: string; addedAt: number }
export interface DataStorePort { mode(): Promise<"multi" | "single">; create(id: string): Promise<void>;
  remove(id: string): Promise<void>; clearAll(): Promise<void> }
export interface ProfileStore {
  list(): Profile[]; current(): Profile | null;
  add(input: { base: string; name: string | null; iconUrl: string | null }): Promise<Profile>; // dedupes by base
  setCurrent(id: string): Promise<"switched" | "cancelled">; // single mode asks first (Decision 9)
  remove(id: string): Promise<void>;
  onRemoved(listener: (p: Profile) => void | Promise<void>): () => void; // push plan seam
}
export function createProfileStore(deps: { prefs: PrefsPort; stores: DataStorePort;
  confirm(text: { message: string; ok: string; cancel: string }): Promise<boolean>; newId(): string; now(): number }): ProfileStore;
```

- [ ] **Step 1: Failing tests** (fakes for prefs, stores, confirm):
  - `add` of the same base twice returns the first profile.
  - `remove` calls `stores.remove(dataStoreId)` after the `onRemoved` listeners and drops the
    entry. Removing the current profile makes `current()` the next one or null.
  - Single mode: `setCurrent` asks with the Decision 9 copy. On cancel nothing changes; on ok
    `clearAll` runs before the switch.
  - A corrupt prefs value reads as no profiles (not a throw).
  - XCTest: `create` / `remove` with `WKWebsiteDataStore(forIdentifier:)` on two UUIDs; a cookie
    set in one is absent in the other.
  - JUnit: the mode follows `isFeatureSupported(MULTI_PROFILE)` (injected).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/runtime/profiles.test.ts`, `test:ios`,
  `test:android` — expect FAIL.
- [ ] **Step 3: Implement.** iOS removes a store only after its WebView is released.
- [ ] **Step 4: Run** the tests — expect PASS.
- [ ] **Step 5: Commit** `feat(mobile): profiles with a data store each`.

### Task 15: Address page and discovery

**Files:** Create `apps/mobile/src/local/address/{index.html,address.ts,address.css}`,
`src/runtime/discovery.ts`, native `HttpGet` in `ShellPlugin` (no redirects, timeout, size cap),
`apps/mobile/test/address.test.ts`.

**Interfaces:**
- Consumes: `normalizeAddress`, `fetchMeta`, `t()` from `@capybara-hq/shell`; `ProfileStore`
  (Task 14); `brand` (Task 12).
- Produces:
  - `discover(input: string, deps: { httpGet: HttpGetPort }): Promise<{ base: string; meta: Meta } | { error: AddressErrorKind }>`.
  - `startRoute(brand, managed, profiles): "address" | { profileId: string }`.

- [ ] **Step 1: Failing tests.**
  - `discover("capybara.example.com")` → base `https://capybara.example.com`.
  - `http://x.example` → `insecure`.
  - A 302 from the fake `httpGet` → `unreachable`.
  - meta without `appSignIn` → `too_old`; `appSignIn: false` → `sign_in_unavailable` (the mobile
    copy key).
  - `startRoute`:
    - with `presetUrl` and no profile → adds the preset and returns it (no address page);
    - `lockToPreset` → the page refuses another address with `address.error.locked`;
    - no preset and no profiles → `"address"`.
  - The page renders the deployment's name and icon (`meta.icons.app` resolved against the base)
    once discovery answers.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/address.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** The page is plain HTML (no design package) and the same layout as the
  desktop's address page. Native `HttpGet` refuses redirects (URLSession delegate / OkHttp
  `followRedirects(false)`) so `fetchMeta`'s `redirect: "error"` holds.
- [ ] **Step 4: Run** the tests, `check:i18n`.
- [ ] **Step 5: Commit** `feat(mobile): address page and discovery`.

### Task 16: Loading, navigation, splash, appearance, errors

Depends on spike 1.1 (the WebView's host view) and the released SDK of Task 2.

**Files:** Create `apps/mobile/src/runtime/{loader,navigation,splash,appearance}.ts`,
`src/runtime/capabilities/chrome.ts`, `src/local/error/{index.html,error.ts}`, native host code
(`ProfileWebView` navigation delegate, `BrowserSheet` with `SFSafariViewController` / Custom Tabs)
and tests `apps/mobile/test/runtime/{navigation,splash,chrome}.test.ts`.

**Interfaces:** Produces:
- `decideNavigation(url, ctx): "allow" | "sheet" | "block"`, where `ctx` is
  `{ profile, isMainFrame, targetBlank, oauthReturnPending }`.
- `createSplash(deps: { hide(): void; schedule(fn, ms): () => void }): { ready(): void; loaded(): void; failed(): void }`
  (3000 ms after `loaded`).
- `chrome@1` impl `{ setAppearance, ready }` (`setAppearance` persists per profile under
  `appearance.<profileId>`).

- [ ] **Step 1: Failing tests.**
  - **Navigation.**
    - A same-origin main frame → `allow`.
    - Another origin top level → `allow` only for a connector OAuth leave-and-return (desktop
      spec §7.1: a navigation started from the profile origin to an authorization URL, returning
      to the profile origin), else `sheet`.
    - `target=_blank` → `sheet`.
    - `javascript:`, `file:` and `data:` top level → `block`.
    - The two sign-in routes as navigations → `block` (Task 17 adds the request block).
  - **Back (Android, amended 2026-11-21).** `decideBack({ canGoBack: true })` → `history`;
    `false` → `background`; it reads no `nav@1` state.
  - **Splash.** `ready()` hides once; `loaded()` then 3000 ms on the injected scheduler hides;
    `failed()` hides at once; a later `ready()` does nothing.
  - **chrome@1.** `scheme: "dim"`, `background: "#12345678"` or `"red"` → `failed`. A valid call
    sets the native background and status bar style through the fake host and persists them. At
    the next launch the stored background is applied before the WebView loads.
  - **Error state.** A main-frame provisional failure (fake host event `didFailProvisional`,
    `ERR_NAME_NOT_RESOLVED`, a TLS error) shows `error/index.html` with retry and the profile
    switcher, never the WebView's page; there is no proceed option on TLS errors. A 500 from the
    deployment stays in the WebView.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/runtime` — expect FAIL.
- [ ] **Step 3: Implement.**
  - iOS: `allowsBackForwardNavigationGestures = true`.
  - Android: `OnBackPressedCallback` goes back in history while `canGoBack()` and the route is
    not a tab root (from the last `nav@1.set`: `visible` with a current id), else
    `moveTaskToBack(true)`. **Amended 2026-11-21:** there are no tab roots and Android has no
    `nav@1`: back goes back in history while `canGoBack()`, else `moveTaskToBack(true)`, decided by
    a pure `decideBack({ canGoBack }): "history" | "background"` in `navigation.ts`. Closing an
    open drawer or sheet first is the web's (maintainer decision 2026-11-21, layout spec §15,
    plan Decision 25): the overlay holds a history entry, so Android's back reports
    `canGoBack() = true`, `decideBack` returns `history` and the WebView's popstate closes the
    overlay; the iOS swipe moves through the same entry. Add a case: `decideBack({ canGoBack:
    true })` is `history` whatever overlay state the page is in (the function takes none).
  - The native splash comes from `@capacitor/splash-screen` with `launchAutoHide: false`.
- [ ] **Step 4: Run** the tests, `test:ios:ui` (a case: launch against the loopback test page that
  calls `capybaraShell.capabilities["chrome@1"].ready()` → the splash is gone, and the background
  equals the page's).
- [ ] **Step 5: Commit** `feat(mobile): loading, navigation, splash and error state`.

### Task 17: Sign-in and the in-WebView block — high risk, review alone

**Files:**
- Create: `apps/mobile/src/runtime/sign-in.ts`, `src/runtime/sign-in-block.ts`.
- Create native code: `AuthSession.swift` (ASWebAuthenticationSession), `AuthSession.kt` (Custom
  Tabs plus the callback activity), `SignInGuard.kt` (port of `isInWindowSignIn`), the content
  rule list compile in `ProfileWebView.swift`, and `ExchangeScript` (a fixed string, no
  interpolation except a JSON argument object).
- Create tests: `apps/mobile/test/runtime/sign-in.test.ts`, `ios/AppTests/SignInBlockTests.swift`
  and `android/app/src/test/.../SignInGuardTest.kt` (both read
  `packages/shell/test/fixtures/in-window-sign-in.json`).

**Interfaces:**
- Consumes: `createPkceWeb`, `checkCallback`, `parseDeepLink`, `SIGN_IN_TTL_MS`,
  `signInBlockRules`, `isInWindowSignIn` (Task 10); `ProfileStore`; `HostPort`.
- Produces `createSignIn(deps)` registered as `signIn@1` (`start` confirming: activation plus the
  dialog gate), with these deps:
  ```ts
  interface SignInDeps {
    auth: { start(url: string, scheme: string): Promise<{ callback: string } | { cancelled: true }> };
    exchange(profileId: string, req: { url: string; body: string }): Promise<{ ok: boolean; status: number; hasAccount: boolean }>;
    currentOrigin(profileId: string): Promise<string | null>; // the profile WebView's top-level origin now
    reload(profileId: string): Promise<void>;
    deviceName: string; appVersion: string; now(): number; newState(): string;
  }
  ```
  The authorize URL is `<base>/apps/authorize?client=mobile&redirect_uri=<scheme>://auth/callback&code_challenge=…&code_challenge_method=S256&state=…&name=<deviceName>&app_version=<v>`.

- [ ] **Step 1: Failing tests.**
  - **Happy path.** `start()` → the auth URL above. The callback with the right `state` and
    `iss` = base → `exchange` gets the token URL and body
    `{"code","codeVerifier","redirectUri"}`. `ok` with an account → `reload`, result
    `"signedIn"`.
  - **Refusals** (each → no `exchange`, result `failed`):
    - wrong `state`;
    - expired after `SIGN_IN_TTL_MS` (injected clock);
    - `iss` of another deployment;
    - a second callback with the same state (one use);
    - a callback after the profile was removed;
    - `currentOrigin` ≠ the profile origin.
  - **Cancel and errors.** `{ cancelled: true }` → `"cancelled"`. An Android resume without a
    callback → `"cancelled"` (Decision 10). Exchange `ok: false` → `failed`, and only the status
    is logged.
  - **Too old.** A profile whose meta lacks `appSignIn` gets the too-old error state, and
    `signIn@1` is not offered.
  - **Block.** XCTest compiles `signInBlockRules(base)` into a `WKContentRuleList` and loads each
    vector URL in a WebView against the loopback server: blocked ones never reach the server
    (server log), the others do. JUnit: `SignInGuard.isInWindowSignIn` equals `blocked` for every
    vector, and `shouldInterceptRequest` returns a 403 `WebResourceResponse` for them.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/runtime/sign-in.test.ts`, `test:ios`,
  `test:android` — expect FAIL.
- [ ] **Step 3: Implement.**
  - iOS: the exchange runs through `callAsyncJavaScript(_, arguments:, in: nil, contentWorld:
    .defaultClient)`.
  - Android: the exchange runs through `evaluateJavascript` (Decision 6), the fetch with
    `credentials: "include"`, `redirect: "error"`, `cache: "no-store"`, header
    `X-Capybara-Csrf: 1`, and a 30 s `AbortSignal.timeout`.
  - The page learns only `"signedIn"` / `"cancelled"`.
  - The ServiceWorker client gets the same Android guard.
- [ ] **Step 4: Run** the tests. Then the manual e2e against a dev kernel with Task 3: sign in on
  an iOS simulator and an Android emulator. The kernel's session list shows
  `Capybara Mobile/<v> (<device>)`.
- [ ] **Step 5: Commit** `feat(mobile): sign in through Safari and Custom Tabs`.

### Task 18: Managed configuration — high risk, review alone

**Files:** Create `apps/mobile/src/runtime/managed.ts`, native `ManagedConfig.swift` (reads
`UserDefaults.standard.dictionary(forKey: "com.apple.configuration.managed")`, observes
`UserDefaults.didChangeNotification`), `ManagedConfig.kt` (`RestrictionsManager`, receiver for
`ACTION_APPLICATION_RESTRICTIONS_CHANGED`), `android/app/src/main/res/xml/app_restrictions.xml`
(two restrictions `presetUrl` string, `lockToPreset` bool) and
`apps/mobile/test/runtime/managed.test.ts`.

**Interfaces:** Produces:
- `parseManaged(raw: unknown): { presetUrl?: string; lockToPreset?: boolean }`.
- `effectivePreset(brand, managed): { presetUrl: string | null; locked: boolean }`.
- `applyPolicy(policy, profiles): { visible: Profile[]; canAdd(base: string): boolean }`.

- [ ] **Step 1: Failing tests.**
  - `parseManaged`:
    - `{ presetUrl: "cap.example" }` → base `https://cap.example`;
    - `"http://cap.example"`, `42` and `"https://u:p@x"` → field dropped;
    - `lockToPreset: "yes"` → dropped;
    - a non-object → `{}`.
  - `effectivePreset`:
    - brand `{ presetUrl: A, lockToPreset: true }` + managed `{ presetUrl: B }` → A, locked;
    - brand unlocked + managed B with lock → B, locked;
    - managed lock without any preset → not locked.
  - `applyPolicy`: locked to A hides profile B and refuses adding B. Changing the policy back
    shows B again, and its store was never removed (fake `DataStorePort.remove` not called).
  - A runtime change event re-runs the policy, and the current profile moves to A.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/runtime/managed.test.ts` — expect FAIL.
- [ ] **Step 3: Implement**, then wire into `startRoute` (Task 15) and the switcher.
- [ ] **Step 4: Run** the tests, `test:android` (a JUnit test for the restrictions parsing).
- [ ] **Step 5: Commit** `feat(mobile): managed presetUrl and lockToPreset`.

### Task 19: `nav@1` native tab bar

> **Superseded 2026-11-21 by Task 31; not to be executed.** No native tab bar on ordinary phones
> or Android; `nav@1` changed shape (Task 23). The text below is kept for the record.

Depends on spikes 1.1 (host: shared WebView under `UITabBarController`, or the
`UIViewReservedRegion` bar) and 1.4 (`insets.right` source).

**Files:** Create `apps/mobile/src/runtime/capabilities/nav.ts`, native `TabHost.swift`,
`TabHost.kt` (Material 3 `NavigationBar` under the WebView), `apps/mobile/test/runtime/nav.test.ts`,
`ios/AppUITests/TabBarTests.swift`.

**Interfaces:**
- Consumes: `MOBILE_SHELL_LIMITS`, `NavStateV1` (SDK); `registry.emit`; `HostPort.pushState`.
- Produces:
  - `validateNavState(input: unknown): NavStateV1 | null`.
  - `navInsets(state, host: { barHeight: number; stripWidth: number; envReportsStrip: boolean; outerDuo: boolean }): Insets`.
  - Native → runtime events `tabSelected(id)` and `tabLongPressed("me")`.

- [ ] **Step 1: Failing tests.**
  - `validateNavState` rejects each of: five items, a duplicate id, id `files`, an empty label or
    one of 33 characters, `count: -1` / `1.5` / `10000`, `current: "files"`, `visible: "yes"`.
    It accepts the four-item state.
  - Badge text: `count: 120` → `99+`; `count: 3, countMore: true` → `3+`; `0` → none.
  - `navInsets`:
    - phone, visible → `bottom: barHeight`; hidden → `bottom: 0`;
    - Duo outer, visible → `bottom: 0`, and `right: stripWidth` only when `!envReportsStrip`;
    - each change triggers one `pushState`.
  - `tabSelected("agents")` reaches the page's `onSelect` listeners.
  - `tabLongPressed("me")` opens the profile switcher (native action sheet via `MenuHost`, Task
    20) instead.
  - XCUITest on the Duo simulator: the outer display shows the bar in the strip. Opening to the
    inner display, where the web sends `visible: false`, hides it with no second bar in the
    hierarchy.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/runtime/nav.test.ts`, `test:ios:ui` —
  expect FAIL.
- [ ] **Step 3: Implement.** Icons per Decision 14. The OS draws badges
  (`tabBarItem.badgeValue` / `BadgeDrawable`).
- [ ] **Step 4: Run** the tests, plus a manual check on an Android foldable emulator (inner display
  → bar hidden).
- [ ] **Step 5: Commit** `feat(mobile): native tab bar through nav@1`.

### Task 20: `haptics@1`, `share@1`, `menu@1`, `openExternal@1`

**Files:** Create `apps/mobile/src/runtime/capabilities/{haptics,share,menu,open-external}.ts`,
native `MenuHost.swift` / `MenuHost.kt`, and `apps/mobile/test/runtime/capabilities.test.ts`.

**Interfaces:** Each is a `CapabilityImpl` (Task 13):
- `share.share` and `menu.show` are `confirming`.
- `haptics.impact` and `openExternal.open` are not.
- Haptics map to `@capacitor/haptics`:
  - `selection` → `selectionChanged`;
  - `light` → `impact({ style: Light })`;
  - `success` / `warning` → `notification({ type })`.
- Share uses `@capacitor/share`. Open external uses `UIApplication.open` / `ACTION_VIEW` through
  `ShellPlugin`.

- [ ] **Step 1: Failing tests.**
  - **Haptics.** `"heavy"` → `failed`; each valid kind calls its plugin function once.
  - **Share.**
    - `url: "javascript:alert(1)"`, `url: "http://other.example"` and a 2049-character URL →
      `failed`;
    - `url: "/chat/c1"` resolves against the profile origin; an `https` URL on another host is
      allowed;
    - no activation → `no_activation`;
    - two at once → the second `busy`;
    - a 4001-character text → `failed`.
  - **Menu.**
    - 13 items, an item id `"a b"`, a 65-character label, a nested `items` field or an `icon`
      field → `failed`;
    - a valid call shows `MenuHost` with destructive and disabled flags;
    - picking resolves the id; dismissing resolves `null`;
    - a disabled item can never be resolved (the fake host attempts it → ignored).
  - **openExternal.** `ftp:` → `failed`; `https:` → opens.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/runtime/capabilities.test.ts` — expect
  FAIL.
- [ ] **Step 3: Implement.** iPad: popover `sourceRect` from `anchor`. Android: a modal bottom
  sheet; the anchor is ignored.
- [ ] **Step 4: Run** the tests, `test:ios`, `test:android`.
- [ ] **Step 5: Commit** `feat(mobile): haptics, share, menus and open external`.

### Task 21: Release workflow (fastlane)

**Files:** Create `.github/workflows/release-mobile.yml`, `apps/mobile/fastlane/{Fastfile,Appfile}`,
`apps/mobile/Gemfile` (+ `Gemfile.lock`), `apps/mobile/test/release-workflow.test.ts`.

**Interfaces:**
- Inputs: `workflow_dispatch` with `ios` (bool), `android` (bool), `upload` (bool, default
  false).
- Secrets: `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_P8`, `IOS_DIST_CERT_P12`,
  `IOS_DIST_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE`, `ANDROID_KEYSTORE_BASE64`,
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`,
  `PLAY_SERVICE_ACCOUNT_JSON` (optional).
- Lanes:
  - `ios beta`: `setup_ci`, `app_store_connect_api_key`, import cert and profile, `build_app`,
    `upload_to_testflight` when `upload`.
  - `android release`: signed `assembleRelease` and `bundleRelease`.
  - `android internal`: `upload_to_play_store(track: "internal")`.

- [ ] **Step 1: Failing test** (parses the YAML with `yaml`):
  - `on` has only `workflow_dispatch`; top-level `permissions: {}`.
  - Every `uses:` is pinned to a 40-hex SHA.
  - The iOS job runs on `macos-*` and starts with a step that fails listing the missing secret
    names when any iOS secret is empty.
  - The Play upload step's `if` requires `inputs.upload` and a non-empty
    `PLAY_SERVICE_ACCOUNT_JSON`. Without it, a step prints a notice that the AAB / APK are
    artifacts only.
  - No `run:` echoes a `secrets.` expression.
  - `apps/mobile/brand.ts` is checked with `check:brand` before building.
  - Build numbers come from `github.run_number`.
  - Artifacts upload the IPA, APK and AAB.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/release-workflow.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Mainland Android stores are not uploaded (spec §10). Run once with
  `upload: false` on the branch through `workflow_dispatch` (the maintainer's secrets) to see
  signed artifacts.
- [ ] **Step 4: Run** the test, `pnpm lint`.
- [ ] **Step 5: Commit** `ci(mobile): release workflow for TestFlight and signed Android builds`.

### Task 22: Fork guide and docs

**Files:** Create `docs/fork-guide.md` and `apps/mobile/store/review-notes.md` (spec §10:
the demo deployment and test account supplied by the maintainer; native chrome, sign-in and share
per guideline 4.2). Modify `AGENTS.md` (map row, mobile commands, the gate rule, spike rulings
link) and `README.md`.

- [ ] **Step 1:** Write the guide. It covers:
  - fork, then change `brand.ts` and `assets/`, then `pnpm --filter @capybara-hq/mobile apply-brand`
    and commit;
  - register `<scheme>://auth/callback` in the deployment's `auth.appRedirectUris`
    (`CAPYBARA_AUTH__APP_REDIRECT_URIS`);
  - optional `presetUrl` / `lockToPreset`, or MDM keys instead;
  - create the signing assets and set the Task 21 secrets;
  - run the release workflow;
  - a placeholder section "Push notifications" pointing to the push plan. It names no credentials
    steps yet: the push plan fills it in with APNs / FCM and the deployment's push plugins.
- [ ] **Step 2:** A test in `apps/mobile/test/fork-guide.test.ts`:
  - every secret name in `release-mobile.yml` appears in the guide;
  - every key of `brand` appears in the guide.
- [ ] **Step 3: Run** `pnpm exec vitest run apps/mobile/test/fork-guide.test.ts`, `pnpm lint`.
- [ ] **Step 4:** Changeset `@capybara-hq/mobile: minor`. Commit `docs(mobile): fork guide and
  store review notes`.

### Task 31: Native strip navigation and menu button (iOS) — replaces Task 19

Added 2026-11-21. Depends on spikes 1.1 (shared WebView under `UITabBarController`) and 1.4
(the strip as `env(safe-area-inset-right)`), Tasks 13 and 16, and the SDK release with Task 23.
iOS only: Android registers no `nav@1` (spec §6.1).

**Files:** Create `apps/mobile/src/runtime/capabilities/nav.ts`,
`ios/App/App/Shell/{StripHost,StripDetector}.swift`, `apps/mobile/test/runtime/nav.test.ts`,
`ios/AppTests/StripDetectorTests.swift`, `ios/AppUITests/StripTests.swift`. Modify
`apps/mobile/src/runtime/registry.ts` (`refresh`), the runtime entry (register `nav@1` on iOS
with `available` reading the host's strip state), Task 16's host view (the profile WebView sits
in `StripHost` while the window has a strip, else in Task 16's plain container; it moves between
them on a change).

**Interfaces:**
- Consumes: `NavStateV1`, `NavSectionId`, `NAV_SECTION_ORDER`, `MOBILE_SHELL_LIMITS` (SDK);
  `CapabilityRegistry`, `HostPort` (Task 13).
- Produces:
  - `validateNavState(input: unknown): NavStateV1 | null`.
  - `badgeText(b: { count?: number; countMore?: boolean }): string | null`.
  - `registry.refresh(profileId: string): void`: re-evaluates every `available` and, when the
    descriptors changed, sends them with one `pushState` (the page's `change`). Additive; the
    push seam `register(key, impl, { available })` is unchanged.
  - Native → runtime events `stripChanged(visible: boolean)`, `sectionSelected(id)`,
    `menuTapped()`.
  - Swift `enum StripDetector { static func hasStrip(safeArea: UIEdgeInsets, reservedRegion: CGRect?) -> Bool }`:
    true when iOS reports a reserved region, else when the trailing side inset is above 0 and the
    leading one is 0. Never the model identifier.

- [ ] **Step 1: Failing tests.**
  - `validateNavState` rejects: an unknown id (`me`, `files`), a duplicate, items out of
    `NAV_SECTION_ORDER`, five items, an empty or 33-character label, `count` -1 / 1.5 / 10000, a
    `current` that is neither null nor an item's id, a missing `menu`, an empty menu label, an
    unknown key (`visible`). It accepts four items, three (a guest) and `menu: null`.
  - `badgeText`: 120 → `99+`; 3 with `countMore` → `3+`; 0 or absent → null.
  - Availability: `stripChanged(true)` → `refresh` → the descriptors hold `nav@1` and the page
    gets one `change`; `stripChanged(false)` → `nav@1` gone, its listeners dropped, one `change`;
    a `set` while unavailable → `failed`.
  - `sectionSelected("agents")` reaches the page's `onSelect` listeners, also for the current
    section; `menuTapped` reaches `onMenu` listeners.
  - Android: the runtime built for Android never registers `nav@1`.
  - XCTest `StripDetector`: Duo outer portrait (right 84, left 0) → true; iPhone portrait (top 59,
    bottom 34) → false; iPhone landscape (left 59, right 59) → false; a reserved region → true.
  - XCUITest on the Duo simulator: the outer display shows the vertical tab bar in the strip with
    four items and the menu button above them; tapping 收件箱 makes the loopback test page's
    `onSelect` handler set the location to `/inbox`; the menu button fires the page's `onMenu`;
    opening to the inner display keeps the strip (decided 2026-11-21: the inner display has the
    right strip too), with exactly one tab bar in the hierarchy and the web's `menu: null`
    there; the fallback below stays only for an OS that reports no strip, where `nav@1`
    disappears and the page's `data-native-nav` goes away; on an iPhone
    17 simulator and an iPad simulator there is no tab bar and `nav@1` is absent.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/runtime/nav.test.ts`, `test:ios`,
  `test:ios:ui` — expect FAIL.
- [ ] **Step 3: Implement.**
  - Icons per Decision 14 (amended); badges through `tabBarItem.badgeValue` from `badgeText`.
  - The menu button sits at the top of the strip above the items: the tab bar's leading
    accessory where iOS 27.1 offers one, else a button in the strip region above the bar; the
    XCUITest pins the result. Its accessible label is `menu.label`.
  - `current: null` leaves the selection as it was; a tap on the selected item still emits
    `sectionSelected` (`tabBarController(_:shouldSelect:)`).
  - Re-measure `env(safe-area-inset-right)` inside the tab child (84 on the outer display); only if
    the child double-counts the strip, keep the safe-area override of the profile WebView (R7).
  - `insets` stay 0.
- [ ] **Step 4: Run** the tests. Manual check on the Duo simulator against a dev deployment with
  Task 30: open and close, rotate, keyboard up; never two navigations, one back animation.
- [ ] **Step 5: Commit** `feat(mobile): native strip sections and menu button through nav@1`.

### Task 32: `profiles@1` (the profile switcher from the web)

Added 2026-11-21. Depends on Tasks 13, 14, 20 (`MenuHost`) and the SDK release with Task 23.

**Files:** Create `apps/mobile/src/runtime/capabilities/profiles.ts`,
`apps/mobile/test/runtime/profiles-capability.test.ts`. Modify the runtime entry (one
`register` line with `available` = not locked, Task 18's policy).

**Interfaces:** Produces
`createProfilesCapability(deps: { profiles: ProfileStore; menu: MenuHostPort; openAddress(): Promise<void>; policy(): { locked: boolean } }): CapabilityImpl`,
with `show` in `confirming` (activation and the per-profile dialog gate). The sheet lists the
visible profiles by name (the current one marked), 「添加平台」 / "Add platform" and 「移除当前平台」
/ "Remove this platform" (destructive, then the native confirm).

- [ ] **Step 1: Failing tests.**
  - No activation → `no_activation`; a second `show` while the sheet is open → `busy`.
  - A locked policy → `profiles@1` absent from the descriptors.
  - Picking another profile → `profiles.setCurrent(id)` (single-store mode asks first, Decision
    9); picking 添加平台 → `openAddress`; dismissing → nothing.
  - Whatever is picked, the page's promise resolves `undefined`; no profile name, id or origin
    is ever in a reply or an event to the page.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/mobile/test/runtime/profiles-capability.test.ts`
  — expect FAIL.
- [ ] **Step 3: Implement.** Removing the current profile goes through `ProfileStore.remove`, so
  its `onRemoved` listeners (the push plan's seam) run.
- [ ] **Step 4: Run** the tests, `test:ios`, `test:android`, `pnpm check:i18n`.
- [ ] **Step 5: Commit** `feat(mobile): profile switcher through profiles@1`.

---

## Self-review notes

- **Coverage:**
  - §4.1 → 11, 13; §4.2 → 12; §4.3 → 14, 15, 17, 18; §4.4 → 16, 7.
  - §5.1 / 5.2 → 2, 13, 16, 19, 20; §5.3 → 1.2, 13.
  - §6.1 → 4, 5, 19; §6.2 → 4, 5, 20; §6.3 → 16. Amended 2026-11-21: §6.1 → 23, 30, 31 (19
    superseded); `profiles@1` (§4.3, §5.2) → 23, 30, 32.
  - §7.1 → 6; §7.2 → 7; §7.3 → 8; §7.4 is held by `check:web-ui` and no task changes tokens
    beyond motion. Amended 2026-11-21: §7.4 now allows the touch set, which Task 24 brings; the
    colors stay.
  - Layout spec §15, decided 2026-11-21: no voice button (Q3 → Decision 24, Task 26), back closes
    an open drawer or sheet first (Q4 → Decision 25, Tasks 16, 25, 27, 28), the Duo inner strip
    (Task 31), no 无痕会话 button (Tasks 27, 28).
  - §8 → 1.4, 9, 19 (now 31); §10 minus push → 21, 22; §13 phases 1–3 → waves 1–7, then the
    remaining-work waves T1–T7.
  - Layout spec as amended 2026-11-21: §4.1 / §4.2 → 27, 28; §4.3 strip-aware entries → 30;
    §4.5 → 24, 25, 26; §4.6 → 29; §8 → 9, 30, 31; §10.2 `start_url` → 28; §11 → the visual
    dispatches of 24–29 and Review Focus 6–8.
  - §14 open questions → 1.1, 1.3, 1.4, recorded in 1.5.
- **Out of scope here:** §9 and `push@1` / `push-provider@1` (the push plan, through the seams
  above); store submission (phase 5, the maintainer).
