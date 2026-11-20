# Mobile app shell (phases 1–3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. With 26 tasks across two repositories, `wave-planned-subagent-development` governs the dispatch (wave table below).

**Goal:** The official Capybara app for iOS and Android (`capybara-hq/clients` `apps/mobile`): it
loads a deployment's own web with native chrome (tab bar, share, haptics, menus, appearance,
Safari / Custom Tabs sign-in). The web gets the native-feel pass, which the browser and the PWA
get too. Organizations can fork, rebrand and release it. Push is not in this plan.

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
| Capabilities | `signIn@1`, `openExternal@1`, `chrome@1`, `nav@1`, `haptics@1`, `share@1`, `menu@1` (`push@1`: push plan); never `device@1`, `notify@1` |
| `insets` | `bottom` = the native tab bar's height while it shows on a phone, else 0; `right` = the Duo strip's width only when the WebView does not report `safe-area-inset-right` (spike 1.4), else 0; `top` / `left` 0 |
| Nav ids | `chats`, `agents`, `inbox`, `me` |
| Haptic kinds | `selection`, `light`, `success`, `warning` |
| Haptic uses | tab switch and a selection change `selection`; sending a message `light`; an approval granted `success`; a destructive confirmation `warning` |
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
   the bottom-nav slot under either.
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
    `person.crop.circle` / `account_circle`.
15. **Touch prefetch** (spec §7.3): today only Next's link prefetch exists on the client. apps/web
    adds `warmRoute`, which runs the route table's queries, on `pointerdown` and when a
    conversation row scrolls into view.

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
   animates once. Tasks 4, 7 and 19.

---

## Cross-repo dependencies and seams

| Needs | From | Used by |
|---|---|---|
| Spike rulings (Capacitor or plain native, tab host, insets.right, Android profiles) | Tasks 1.1–1.5 | 11, 13, 14, 16, 19 |
| `@capybara-hq/plugin-sdk` release with Task 2's types (the core Version Packages PR) | Task 2 | Clients 13, 16, 19, 20 (bump the exact version) |
| Kernel accepting `client: "mobile"`, in a released kernel | Task 3 | Task 17 (its e2e against a dev kernel) |
| `packages/shell` lifts | Task 10 | 13–18 |

**Seams left for the push plan (stated, not built):**
- The runtime's `CapabilityRegistry.register(key, impl, { available })`: `push@1` registers
  there, available only when the build has push credentials and meta lists it.
- `ProfileStore.onRemoved(listener)`: profile removal deletes the push registration there.
- `brand.ts`: the push plan adds its own optional `push` field. This plan adds none.
- The runtime's `DeepLinkRouter`: push taps that carry a deployment origin route through it to a
  profile.

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
| 19 `nav@1` native tab bar | clients | 1.1, 1.4, 13, 16 | normal | 6 | batched |
| 20 `haptics@1`, `share@1`, `menu@1`, `openExternal@1` | clients | 13 | normal | 6 | batched |
| 21 Release workflow | clients | 12 | normal (secrets) | 7 | batched |
| 22 Fork guide and docs | clients | 12, 17, 21 | normal | 7 | batched |

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

### Task 9: Duo edge to edge on the web (spec §8)

Depends on spike 1.4 only for the record. The CSS is the same either way, because
`--cb-inset-right` is `max(env(safe-area-inset-right), var(--cb-shell-inset-right, 0px))`.

**Files:** Modify `packages/design/src/styles/{shell,templates,conversation-page}.css`. Test:
`packages/design/test/duo-edge.test.ts` (new), `apps/web/visual/duo.spec.ts` (new; baselines via
`visual-update`).

- [ ] **Step 1: Failing tests.**
  - `duo-edge.test.ts`: the full-bleed grounds have no `margin-right` / `right` offset by an
    inset: the page body, `.cb-shell-topbar`, `.cb-action-row`, the composer dock and
    `.cb-bottomnav`.
  - Their inner content declares `padding-inline-end` (or `padding-right`) containing
    `var(--cb-inset-right)`.
  - Under `[data-native-nav]` the shell's bottom padding still uses `--cb-inset-bottom` (the
    native bar's height).
- [ ] **Step 2:** Add `duo.spec.ts`. At 382 × 800 with
  `document.documentElement.style.setProperty("--cb-shell-inset-right","44px")`, take screenshots
  `duo-outer-list` (`/conversations`) and `duo-outer-chat` (`/chat/<fixture>`). The ground runs to
  the right edge; text and controls end 44 px before it.
- [ ] **Step 3: Run** `pnpm exec vitest run --project design packages/design/test/duo-edge.test.ts`
  — expect FAIL. Then implement, and run again — expect PASS.
- [ ] **Step 4:** Dispatch `visual-update` on the branch; review the two new baselines.
- [ ] **Step 5:** Changeset `@capybara-hq/web: patch`. Commit `feat(design): edge to edge under the
  Duo strip`.

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
    `moveTaskToBack(true)`.
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

---

## Self-review notes

- **Coverage:**
  - §4.1 → 11, 13; §4.2 → 12; §4.3 → 14, 15, 17, 18; §4.4 → 16, 7.
  - §5.1 / 5.2 → 2, 13, 16, 19, 20; §5.3 → 1.2, 13.
  - §6.1 → 4, 5, 19; §6.2 → 4, 5, 20; §6.3 → 16.
  - §7.1 → 6; §7.2 → 7; §7.3 → 8; §7.4 is held by `check:web-ui` and no task changes tokens
    beyond motion.
  - §8 → 1.4, 9, 19; §10 minus push → 21, 22; §13 phases 1–3 → waves 1–7.
  - §14 open questions → 1.1, 1.3, 1.4, recorded in 1.5.
- **Out of scope here:** §9 and `push@1` / `push-provider@1` (the push plan, through the seams
  above); store submission (phase 5, the maintainer).
