# Mobile app shell and push notifications

- Date: 2026-11-20, written against `origin/main` at `dec9a7a51`.
- Status: approved by the maintainer on 2026-11-20 (with the iPhone Duo edge-to-edge rule of §8
  and the Safari sign-in sheet of §4.3 confirmed); the designer's calls stand.
- Related: the mobile layout and Shell environment spec (`2026-11-19-mobile-layout-design.md`,
  "layout spec" below: §4 the compact shell, §7 mobile specifics, §8 foldables, §9 the Shell
  environment, §10 PWA and notifications), the desktop client spec
  (`2026-11-07-desktop-client-design.md`, "desktop spec": §6 connecting and sign-in, §8
  capabilities), the transactional outbox (`2026-11-12-transactional-outbox-design.md`), the
  design spec (`docs/design/spec.md`), and the `capybara-hq/clients` repository (`apps/desktop`,
  `packages/shell`).
- Markers: **(decided)** is a maintainer decision (dated); **(designer's call)** is decided here
  and open to the review. Unmarked text restates current code or the specs above.

## 1. Why

The compact layout (layout spec, released in web rc.68) made every page work on a phone, in the
browser and as an installed PWA. The maintainer's verdict after using it on an iPhone and an
iPhone Duo (2026-11-20): it still feels like a web page, not an app. They want a mobile app with
a **more native feel**, adapted to the iPhone Duo the way Apple's own apps are (the App Store puts
its tabs in the outer display's right strip, under the status bar), and **push notifications**
for organizations that build and publish their own copy of the app.

React Native was weighed again and stays out (decided 2026-11-20, approach A below): a UI bundled
in a store build skews against self-hosted kernels of other versions, plugin UI exists only as
web, and every page would be written twice. The app stays a shell around the deployment's own
web; the native feel comes from **native chrome around the web** plus **a polish pass on the web
itself**, which the browser and the PWA also get.

## 2. Approaches (decided 2026-11-20: A now, B later)

| | What | Trade-off |
|---|---|---|
| **A** (chosen) | Capacitor, one WebView per profile. The shell draws the tab bar natively (UITabBar on iOS, a Material navigation bar on Android) and offers native share, haptics, action menus, push; the web gets a native-feel pass (transitions, gestures, touch feedback, no flashes) | One UI. Push and pop stay web transitions (polished, not native) |
| **B** (later phase) | A native navigation stack where each pushed page is its own WebView (the Hotwire Native model), with a native top bar | Truly native push, pop and swipe-back; costs a WebView per pushed page and a routing contract with the Next client router. Builds on A: nothing in A is thrown away |
| C | React Native | The most native; rejected for the reasons in §1 |

## 3. Goals, non-goals, anti-goals

Goals:

1. An official Capybara app for iOS and Android (App Store, Google Play) that loads a
   deployment's own web, with the Capybara name and icon **(decided, layout spec §10.4)**.
2. **Native chrome**: the four compact tabs drawn by the OS's own tab bar; native share, haptics
   and action menus; native sign-in sheet; no white flashes at launch or between pages.
3. **iPhone Duo**: on the outer display the tabs sit in the system's right strip as in Apple's
   apps; on the inner display the web's medium / expanded layout (rail or sidebar) takes over and
   the native tab bar hides. Android foldables follow the same rules.
4. **Push notifications** for the four categories already decided (layout spec §10.3), delivered
   by the deployment itself to an app whose push credentials the deployment holds.
5. **Self-built apps**: an organization forks `capybara-hq/clients`, changes one brand file and
   its assets, adds its signing and push credentials, and publishes its own build through a
   documented pipeline. A build may preset its deployment.
6. The browser and the PWA get the web half of the polish (§7) and stay first-class.

Non-goals:

- Tablets as a designed target (designer's call): the build is universal and an iPad or Android
  tablet simply shows the web's medium / expanded layout with the native tab bar hidden; no
  tablet-specific chrome, screenshots or review scope in this design.
- Approach B (native navigation stack) and a native top bar: a later design.
- 「连接本机」 on a phone: no `device@1` in the mobile shell.
- An official push relay run by Capybara **(decided, layout spec §10.3)**. Consequence: the
  official store app receives no push, because a deployment cannot hold the push key of the
  Capybara developer account (§9.1).
- Offline use, a local cache of conversations, a bundled copy of the web.
- Biometric app lock, widgets, Siri / App Intents, a share extension that receives files into a
  conversation: later candidates, each its own small design.
- Native UI for any page content: pages, forms, the conversation thread stay web.

Anti-goals (a failure even if it works):

- The deployment's page, a client extension or any other origin calling a native API without the
  Shell environment's origin rule and confirmations (layout spec §9.4): in particular Capacitor's
  own plugin bridge reachable from a remote page (§5.3).
- A push payload that carries conversation content to Apple or Google when the platform did not
  turn previews on (§9.5).
- A push credential or a device push token readable by an agent, a log or the audit in clear.
- Two tab bars at once (native and web), or a double animation on back.

## 4. The app

### 4.1 Repository and stack (designer's call)

`capybara-hq/clients` gains `apps/mobile` (`@capybara-hq/mobile`, private, versioned by
changesets like `apps/desktop`). Capacitor (current major) with its iOS (Swift) and Android
(Kotlin) projects checked in. **Capacitor is the starting point, not a constraint (decided
2026-11-20):** if phase 1's spikes show that the origin gate, per-profile data stores or the shared
tab-bar WebView mostly fight Capacitor's single configured WebView, the app becomes plain native
shells (Swift and Kotlin hosting the WebViews), keeping Capacitor only for the local pages or
dropping it; the capabilities, the gate and everything else in this spec stay the same. The
ruling is recorded here after the spikes; the app's own TypeScript (address page, bridge glue) reuses
`packages/shell` (address normalization, `GET /api/v1/meta` parsing, PKCE, the sign-in callback,
the zh / en catalog). The repository rules stay: published core packages only
(`@capybara-hq/plugin-sdk` for the Shell environment types), tests without real Keychain or OS
services (injected fakes).

Native code is kept to what Capacitor and its official plugins do not cover: the tab bar host,
the origin gate (§5.3), profiles' data stores, the sign-in session and the push hand-off. Each
native module has a TypeScript-facing contract tested with fakes; the native side gets XCTest /
JUnit tests for the origin gate and the profile store.

### 4.2 Brand file

`apps/mobile/brand.ts` (as `apps/desktop/brand.ts`) is the only brand file: app name, bundle id /
application id (official: `com.capybarahq.mobile`), URL scheme (official `capybara`), icon and
splash sources, and an optional **preset deployment** (`presetUrl`, `lockToPreset`). A script
writes the native projects' identifiers, icons and Info.plist / manifest entries from it; CI
fails when the native projects drift from it.

### 4.3 Connecting, profiles and sign-in

- **Address page**: a local page (plain HTML, as the desktop's, no `@capybara-hq/design`): one
  field, normalization and the https-only rule from `packages/shell`, discovery through
  `GET /api/v1/meta`, the deployment's name and icon once it answers. A build with `presetUrl`
  skips it; with `lockToPreset` no other deployment can be added.
- **Profiles**: several deployments, each in its own data store (iOS `WKWebsiteDataStore` with an
  identifier, iOS 17+; Android: a profile per deployment through `androidx.webkit` multi-profile
  where available, else one deployment at a time with a cleared store on switch — designer's
  call, measured in the plan). The switcher is a native action sheet from a long press on the 我
  tab and from the address page; removing a profile deletes its store and its push registration
  (§9.3).
- **Sign-in** is `signIn@1` over the desktop's flow (desktop spec §6.5) in Safari (decided
  2026-11-20): `ASWebAuthenticationSession` on iOS, the Safari sheet over the app that shares
  Safari's cookies, passwords and SSO sessions; Custom Tabs (the default browser) on Android; returning through
  `<scheme>://auth/callback`. The scheme of every build is registered in the deployment's
  `auth.appRedirectUris` (the official one by default, a fork's by its super admin).
- **No sign-in inside the WebView** (designer's call, as the desktop): the WebView refuses the
  deployment's password and SSO start requests and shows the browser sign-in only; a deployment
  without `features.appSignIn` gets the "too old" error state. The code exchange runs from the
  page's own context (a `fetch` in the profile's WebView after the callback), so the session cookie
  lands in the profile's data store without native cookie copying.
- **Managed configuration**: iOS AppConfig / Android managed configurations may set
  `presetUrl` and `lockToPreset`, the same keys as the brand file, so an MDM can pin the official
  app to one deployment without a fork.

### 4.4 Loading and navigation

- The WebView loads the profile's origin. Same-origin navigations stay; connector OAuth may leave
  the origin top-level and come back, as on the desktop (desktop spec §7.1); `target=_blank` and
  other origins open in an in-app browser sheet (`SFSafariViewController` / Custom Tabs).
- **Launch without a flash**: the native splash stays until the web's first paint (the web tells
  the shell through `chrome@1.ready()`, §6), with the theme's background set natively from the
  last `chrome@1.setAppearance` of the profile.
- **Back**: iOS enables the WebView's back-forward swipe (`allowsBackForwardNavigationGestures`),
  which moves through the same history the web's back button uses; Android's back gesture goes
  back in history, and at a tab root moves the app to the background. The web suppresses its own
  pop animation when the browser already animated (`PopStateEvent.hasUAVisualTransition`), so a
  swipe never animates twice (§7.2).
- **Errors**: a deployment that cannot be reached shows a native error state with retry and the
  profile switcher, never the WebView's error page.

## 5. The mobile shell in the Shell environment

### 5.1 Values

| Field | Mobile value |
|---|---|
| `version` | `1` |
| `kind` | `"mobile"` |
| `platform` | `"ios"` or `"android"` |
| `shellVersion` | The app's version |
| `insets` | The native chrome over the WebView beyond the OS safe areas: `bottom` the native tab bar's height while it shows on a phone; `right` on the Duo outer display the strip's width when the WebView does not already report it as `safe-area-inset-right` (§8), else 0; announced with `change` |
| `controls` | Absent |
| `capabilities` | `signIn@1`, `openExternal@1`, `chrome@1`, `nav@1`, `haptics@1`, `share@1`, `menu@1`; `push@1` when the build has push credentials and the deployment's meta lists the build (§9.2) |

`device@1` and `notify@1` are absent (no local device; push replaces in-app OS notifications).

### 5.2 New and extended capabilities (registered in layout spec §9.2 by this spec)

| Capability · function | Does |
|---|---|
| `chrome@1.ready()` (new function) | The web's first paint is done: the shell drops its splash. Additive; the desktop may ignore it |
| `nav@1.set({ items, current, visible })` | The four compact tabs (`id` of `chats` / `agents` / `inbox` / `me`, label, count, `countMore`), the current id and whether the bar shows. The shell draws them natively with its own fixed icon per id (no icon data crosses), the count as the OS badge style |
| `nav@1.onSelect(cb)` | A tab was tapped: the web navigates to that tab's href (the web owns routes) |
| `haptics@1.impact(kind)` | `selection`, `light`, `success`, `warning`; no confirmation |
| `share@1.share({ title?, text?, url? })` | The OS share sheet; `url` must be on the profile's origin or https; needs a user activation |
| `menu@1.show({ title?, items, anchor? })` | A native action sheet / menu of plain items (`id`, label, `destructive?`, `disabled?`); resolves the chosen id or null. No nesting, no icons from the page; needs a user activation |
| `push@1.status()` / `push@1.register()` / `push@1.unregister()` | §9.3 |

All follow the layout spec §9.2 / §9.4 rules: detection by key, absent means the browser, every
input validated, a confirming call needs a user activation and one native dialog at a time.

### 5.3 The origin gate (decided rule, designer's mechanism)

Capacitor's own JavaScript bridge (`window.Capacitor`, `Capacitor.Plugins.*`) is **never
available to a remote page**: it is injected only into the app's local pages (the address page,
the error state). For the profile's origin the shell injects its own document-start script into
the top frame only, which defines `window.capybaraShell` and talks to one native message handler;
that handler checks every message's frame (main frame, exact profile origin) before dispatching
to the capability, and drops anything else. Frames (`/plugin-ui` embeds, the HTML render, file
previewers) and other origins get nothing. The plan proves the mechanism on both platforms (iOS:
`WKUserScript` with `forMainFrameOnly` and a `WKScriptMessageHandler` checking
`message.frameInfo`; Android: `WebViewCompat.addWebMessageListener` with the origin allow-list),
with a test page that tries the bridge from a frame and from a navigated-to origin.

Clarified (decided 2026-11-21, spike 1.2): see §15, "The origin gate, clarified".

## 6. Native chrome and the web

### 6.1 The tab bar

- When `nav@1` is present, the web stops drawing `BottomNav` and calls `nav@1.set` instead:
  items from the same `useNav` data, `visible` true exactly when the web would have shown its own
  bar (compact class, tab root, keyboard closed). The design shell takes the native handler as a
  prop from apps/web (`lib/shell.ts` adapter; design imports nothing from the shell), and sets
  `data-native-nav` on the shell so its CSS drops the bar's slot.
- **iOS**: the shell hosts the WebView in a `UITabBarController`-based container whose four tabs
  share the one WebView (it moves into the selected tab's view), so the OS places and styles the
  bar: the standard bar on phones, the vertical bar in the right strip on the iPhone Duo outer
  display (Apple's default for tab bars, iOS 27.1). If sharing one WebView across tab children
  proves unworkable in the plan's spike, the fallback is a custom bar placed with
  `UIViewReservedRegion` (iOS 27.1); either way the result must match Apple's placement.
- **Android**: a Material 3 `NavigationBar` under the WebView; on a foldable's inner display the
  web's medium / expanded layout shows and the bar hides (`visible` false).
- `insets.bottom` carries the bar's height while it shows, so the web's bottom-pinned rows sit
  above it; on the Duo outer display the bar sits in the strip, which the content already keeps
  clear (§8), so it adds no bottom inset.

### 6.2 Menus, share and haptics

- **Menus**: on compact with `menu@1`, the design's overflow menus (the top bar's, a row's) and
  long-press menus open as native menus; elsewhere and without the capability they stay design
  popovers / bottom sheets. Menus whose items are not plain (checkbox groups, inputs) stay web.
- **Share**: the existing share actions (file shares, a conversation link) use `share@1` when
  present, the Web Share API in a browser that has it, else copy-link as today.
- **Haptics** (designer's call, small set): a tab switch and a selection change (`selection`),
  sending a message (`light`), an approval granted (`success`), a destructive confirmation
  (`warning`). The browser path is a no-op.

### 6.3 Status bar and appearance

`chrome@1.setAppearance({ scheme, background })` (already defined) sets the status bar style and
the WebView's background natively, so overscroll and the launch never show a mismatched color.

## 7. The web's native-feel pass (core; browser and PWA too)

Every item lands in `packages/design` (CSS and components) or the shell adapter; pages change
nothing. Each has a jsdom or visual check where one is possible.

### 7.1 Touch

- No tap highlight (`-webkit-tap-highlight-color: transparent`) and a design pressed state on
  every interactive element instead (most already have one; the pass audits all).
- `touch-action: manipulation` on interactive elements (no double-tap zoom delay); pinch zoom of
  the page stays (layout spec §7.1).
- No text selection or callout on chrome (bars, tabs, buttons, list rows' non-text parts);
  thread text, code and inputs stay selectable.
- `overscroll-behavior: none` on the shell's root so the whole app never rubber-bands; inner
  scroll areas keep their own bounce.

### 7.2 Transitions

- Push and pop keep the layout spec §4.1 slide, tuned to the platform: duration and easing from
  the iOS / Android navigation defaults (tokens), the outgoing page parallaxed and dimmed.
- **No double animation**: a pop whose `PopStateEvent.hasUAVisualTransition` is true (Safari's,
  the iOS WebView's and Chromium's back gesture) swaps instantly.
- Tab switches never animate a slide (as native tab bars do).

### 7.3 Perceived speed

- Tab roots and the next likely push (a conversation from the list) are prefetched (the route
  table already prefetches on hover; on touch, on `pointerdown` and when a row scrolls into view).
- Pages show their template's skeleton at once, never a blank area (the templates have
  skeletons; the pass checks every compact route).
- Returning from the background resumes streams from the event log (layout spec §7.6, already
  decided) without a reload.

### 7.4 What stays

The design direction (E 终端: its type, colors and mono details) is not changed by this pass; the
native feel comes from behavior, not from imitating the OS look inside pages.

## 8. iPhone Duo and foldables

- The size classes already cover the displays (layout spec §8): outer 382 px wide is compact,
  inner portrait medium, inner landscape expanded.
- **Outer display in the app: edge to edge under the strip (decided 2026-11-20).** The WebView
  covers the whole display, the right strip included, as Apple's own apps draw their background
  under it (the App Store's ground runs to the right edge). Backgrounds and full-bleed grounds (the
  page, the top bar, the bottom-pinned rows) extend under the strip; content, text and controls
  stay left of it, padded by the strip's safe-area inset on the right (`--cb-inset-right`, per
  side). The native tab bar sits in the strip below the status bar (§6.1). The shell sets the
  WebView to ignore the safe area and passes the strip through `env(safe-area-inset-right)` (or,
  where the WebView does not report it, through `insets.right`, §5.1); the spike of phase 1
  confirms which on the Device Hub simulator.
- **The same in the browser and the PWA** where WebKit allows it: the web already sets
  `viewport-fit=cover` and pads every side by its own inset, so the day Safari extends content
  under the outer display's side controls (Apple has not decided, layout spec §15), the page runs
  under the strip with no change. Until then the strip stays the system's in Safari and the PWA.
- **Inner display**: the web shows the rail or the sidebar; `nav@1` reports `visible` false and
  the native bar hides. Open and close are resizes: the web's class changes and it calls
  `nav@1.set` again.
- **Browser and PWA on the Duo**: unchanged from the layout spec: the web bottom bar on the outer
  display (the strip belongs to Safari or the system), the rail or sidebar inside.
- The two open questions of layout spec §15 (WKWebView support of the posture and segment APIs,
  `viewport-fit=cover` on the outer display) are answered in the plan's first spike on the Xcode
  27.1 Device Hub simulator and recorded in this spec.

## 9. Push notifications

Every push channel is a plugin (decided 2026-11-20): Apple, Google and a mainland-China
aggregator are one plugin each, behind one kernel extension point. The kernel never speaks a push
protocol itself.

### 9.1 Who can receive push (decided 2026-11-20)

Push is delivered by the deployment itself, with credentials its super admin configures: an APNs
key (`.p8`, key id, team id) for iOS builds, an FCM service account for Android builds. A push
reaches an app only when the deployment holds the credentials of the account that published it,
so in practice **a self-built app** (a fork of the clients repository) **with its own
credentials**. The official store app has no push unless a later design adds a relay; it shows no
push setting then (`push@1` absent).

### 9.2 Kernel: the push extension point (designer's call)

Following the kernel's rule that capabilities are extensions:

- A new extension point **`push-provider@1`** in `@capybara-hq/plugin-sdk` (named apart from the
  Shell environment capability `push@1`): `send({ registrations, message }) -> results[]` per
  registration (`delivered`, `unregistered`
  (the token is dead: the kernel deletes the registration), `failed` with a `PushError` kind:
  `auth` (bad credentials: the platform is told through a setup check), `rate_limited`,
  `transient`). `apps()` lists the app ids (bundle ids / application ids) the configured
  credentials cover. No retries inside the extension (the kernel's queue retries `transient`).
- Three plugins in `capybara-hq/plugins`, one per channel: **`push-apns`** (HTTP/2 token auth;
  config: key, key id, team id, bundle ids, sandbox or production per bundle), **`push-fcm`** (HTTP
  v1; config: service account JSON, application ids) and **one mainland-China aggregator** (a
  service that reaches Huawei, Honor, Xiaomi, OPPO and vivo phones through their vendor channels
  with one SDK and one server API; which aggregator, e.g. Getui or JPush, is chosen in the plan by
  vendor coverage, terms and a server API without a long connection). Secrets through `secret()`;
  setup checks validate the credentials without sending. More channels later are more plugins
  with no kernel change.
- **Each registration names its channel**: the provider key is the plugin's name (`push-apns`,
  `push-fcm`, the aggregator's), and the kernel sends through exactly that extension. One Android
  build may carry FCM and the aggregator SDK and register with whichever works on the phone
  (designer's call in the plan: FCM when Google Play services are present, else the aggregator).
- `GET /api/v1/meta` gains `features.push: [{ appId, providers: string[] }]`, the app ids and
  channels the enabled push extensions cover (public: app ids are not secret). An app offers
  `push@1` only when its own id is listed with a channel it carries.

### 9.3 Registrations

- After sign-in, `push@1.status()` tells the web whether the OS permission is `granted`,
  `denied` or `prompt`. The web asks in context (the first time the person has something waiting,
  or from the notification settings), never at launch; `push@1.register()` (user activation)
  shows the OS prompt and returns `{ platform, appId, provider, token }`.
- The web posts it to `POST /api/v1/me/push-registrations` (`{ platform, appId, provider, token,
  locale, deviceName }`). Table `capybara.push_registrations`: id, user id, platform, app id,
  provider, token
  (sealed at rest like other secrets, with a hash column for uniqueness), locale, device name,
  created / last seen; unique per (provider, app id, token hash). The token belongs to the user, not an org:
  one registration serves every org the person is in.
- Sign-out and profile removal call `DELETE /api/v1/me/push-registrations/:id` (the shell keeps
  the id) and `push@1.unregister()`. A password change, a disabled account or a revoked session
  deletes the user's registrations. A registration not seen for 60 days is deleted by a locked
  periodic job.
- Personal settings gain **通知 / Notifications**: the person's registrations (device name, last
  seen, remove) and the four category switches.

### 9.4 What triggers a push

The four categories of layout spec §10.3, each from its existing kernel event, per recipient:

| Category | Event | Recipient |
|---|---|---|
| Waiting for you | `approval_requested`, `question_asked` (and a connect request) | The person asked |
| Agent replies | A run finishes completed or failed (`RunFinish.finishIn`) | The conversation's owner |
| Task status | `background_task_finished`, `subagent_finished` | The conversation's owner |
| Scheduled tasks | A task run finishes or fails (`ScheduleRunTracker.onRunFinished`) | The task's owner |

- Preferences: table `capybara.push_preferences` (user id, category, enabled); every category on
  by default once the person has a registration.
- Delivery: the event's transaction writes an outbox row (`OutboxService.add`) naming the event;
  its handler resolves recipients, preferences and registrations, renders the message in each
  registration's locale and enqueues one BullMQ job per registration on `cap-push-deliver`, job id
  `push-<eventId>-<registrationId>` (deterministic, no `:`). The worker calls the extension the
  registration names (its provider), if enabled and covering its app id; `transient` and `rate_limited` retry with backoff,
  `unregistered` deletes the registration. The queue consumer lives under `WorkerModule`.
- **No dedup with IM** (decided): a channel card and a push may both arrive.
- **In the foreground**: the shell does not present a push whose `path` is the page on screen;
  any other shows as a banner.
- **"Not viewing" is judged on the receiving phone only** (designer's call): the kernel keeps no
  viewer-presence record, so a person reading the conversation on the desktop still gets the
  phone push. A presence record (Redis with TTL and client heartbeats) is a later refinement if
  the duplicate proves annoying.
- **Scope** (designer's call): push credentials and `push.previews` are platform deployment config
  with no org level; an org cannot change them. Recipients are people, and the per-person category
  switches are the only opt-out. `features.push` in the org-blind meta is therefore right.

### 9.5 The message

- `title`: the agent's name (or the scheduled task's); `body`: a fixed sentence per category in
  the person's language ("needs your approval", "finished", "failed", "your scheduled task ran");
  `path`: the conversation or inbox item. Tapping opens the app on that path in the right profile
  (the payload carries the deployment origin; the shell matches it to a profile).
- The message is one channel-neutral shape (`title`, `body`, `path`, `threadId`, `badge?`,
  `origin`); each plugin maps it to its channel's payload.
- **Previews off by default**: no conversation title, message or tool text leaves the deployment.
  A platform setting `push.previews` (off / titles) may add the conversation title; message text
  is never sent.
- iOS: `thread-id` per conversation (grouping), badge = the person's inbox count where cheap,
  else no badge (designer's call in the plan).

## 10. Self-built apps

- A **fork guide** in the clients repository: change `brand.ts` and the assets, register the
  scheme in the deployment's `auth.appRedirectUris`, create the APNs key / FCM project, configure
  the push plugins of the channels the build carries on the deployment, build and publish.
- A **release workflow** (GitHub Actions, macOS runner for iOS) builds signed iOS and Android
  artifacts (iOS to TestFlight; Android as a signed APK / AAB, uploaded to the Play Console
  internal track only when its secrets are set: mainland stores are uploaded by the organization
  itself) (fastlane, designer's call), driven entirely by repository secrets; the official app uses the same workflow with the
  maintainer's secrets.
- Store review notes for the official app: App Review needs a reachable demo deployment and a
  test account (the maintainer provides one); the native chrome, sign-in and share are what
  distinguish the app from a bare website (App Store guideline 4.2).

## 11. Security summary

- The Shell environment rules hold unchanged (top frame, exact origin, per-call check, user
  activation, one dialog); Capacitor's bridge never reaches remote origins (§5.3).
- No capability returns a credential; `push@1.register()` returns the push token to the page,
  which posts it to its own deployment over the session (a push token addresses this app install;
  it is not a sign-in secret, but it is stored sealed and never logged or audited in clear).
- Push credentials live in extension deployment config as secrets; the push payload carries no
  content unless the platform opts into titles.
- In-app browsing of other origins happens in the OS browser sheet, never the profile's WebView.

## 12. Core changes

- `packages/plugin-sdk`: `push-provider@1` contract; the Shell environment types gain `nav@1`, `haptics@1`,
  `share@1`, `menu@1`, `push@1`, `chrome@1.ready` (changeset, `gen:sdk-api`).
- `packages/kernel`: push registrations and preferences (migration, routes, DTOs, error codes),
  the outbox handler and `cap-push-deliver` worker, the `push-provider@1` host, `features.push` in meta,
  the stale-registration job, `push.previews` config, Platform operations or exclusions for the
  new routes.
- `packages/design`: the native-feel pass (§7), `data-native-nav`, the menu / share / haptics
  hooks as props.
- `apps/web`: the `lib/shell.ts` accessors for the new capabilities, the notification settings
  page, the in-context push prompt.

## 13. Phases (designer's call)

1. **Spikes** (clients): one shared WebView under a tab bar controller on iOS 27.1 incl. the Duo
   simulator; the origin gate on both platforms; Android profiles. Results recorded here.
2. **Web native-feel pass** (core, ships to browser and PWA at once).
3. **App shell** (clients): address page, profiles, sign-in, the gate, `chrome@1`, `nav@1`,
   `haptics@1`, `share@1`, `menu@1`, error states; TestFlight / internal track builds.
4. **Push** (core kernel + web, plugins `push-apns` / `push-fcm` / the aggregator, clients `push@1`), fork guide
   and release workflow.
5. Store submission of the official app (maintainer: accounts, certificates, demo deployment).

## AGENTS.md rules touched

- **SDK public API.** New extension point `push-provider@1` and new Shell environment capability types:
  `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`.
- **Multi-replica discipline.** Push delivery is owed work: an outbox row in the event's
  transaction, a BullMQ job per registration with a deterministic id without `:`, consumers and
  the stale-registration `@LockedCron` under `WorkerModule`. Nothing lives in process memory.
- **Migrations.** Two expand-only tables in schema `capybara` (`push_registrations`,
  `push_preferences`).
- **Kernel.** New routes with `createZodDto` DTOs, registered error codes, `@Transactional` writes.
- **Platform tool.** Each new route gets an operation (the preferences) or an exclusion with a
  reason (registration is a device action of the person's app).
- **Config.** `push.previews` (platform level, hot, not secret); the push plugins' credentials
  are extension deployment config with secrets.
- **Extensions / plugins.** A new extension point and three plugins in `capybara-hq/plugins`;
  policy and usage hooks are not involved (no model call).
- **Web UI.** Pages still write no styles; the pass is design CSS and components; new settings
  page on a template with `defineQuery` / `useAppMutation`.
- **Language / i18n.** New UI and push texts in zh and en (平台 / 超级管理员 / 智能体).
- **Dependency direction.** Unchanged: the clients repository depends on published
  `@capybara-hq/plugin-sdk` only; design takes shell handlers as props.

## 14. Open questions

1. Sharing one WebView across `UITabBarController` children (§6.1): proven in the spike, else the
   `UIViewReservedRegion` fallback.
2. Android multi-profile WebView availability on the devices we target (§4.3).
3. The layout spec's §15 questions, answered on the Duo simulator in phase 1.

## 15. Spike results (2026-11-21)

Phase 1 spikes ran on iOS 27.2 simulators and Android API 35 (WebView 124 and 145) and API 24
(WebView 53). No fallback of §14 was triggered. Rulings are the coordinator's (designer's call,
spike) unless marked as the maintainer's.

### 15.1 The four open questions of §14

1. **Capacitor kept** (designer's call, spike 1.2, 2026-11-21). Capacitor 8.6.2 coexists with the
   gate on iOS and Android; all four gate documents pass.
2. **Tab host: one shared WebView under `UITabBarController`** (designer's call, spike 1.1).
   Reload, blank state, placement, hide/show and focus all passed; `UIViewReservedRegion` is not
   needed. If wrong: swap the host inside `TabHost.swift`.
3. **`insets.right` comes from `env(safe-area-inset-right)`**, the shell reports 0 (designer's
   call, spike 1.4). On the iPhone Duo outer display `env()` reports 84, the strip width, and
   backgrounds under the strip render correctly. The layout spec's §15 questions are answered
   there.
4. **Android: multi-profile where supported, single-store fallback elsewhere** (designer's call,
   spike 1.3). `MULTI_PROFILE` passes on WebView 124 and 145 (isolation, persistence, delete and
   recreate cold) and is absent on WebView 53. The minimum WebView is **supported on 124, not on
   53**; the gate is the runtime feature check (`WebViewFeature.MULTI_PROFILE`), not a version
   number. The single store follows decision 9 below.

### 15.2 Further rulings (designer's call, spike)

- `insets.bottom`: the profile WebView reports the window's safe area (a `WKWebView` subclass
  overriding `safeAreaInsets`), so `env(safe-area-inset-bottom)` excludes the native bar and
  `insets.bottom` is the bar height (§5.1). The spike's `env()` bottom double-counted the bar.
- Android profile WebViews never use the default profile while Capacitor runs: `CapacitorCookies`
  wipes default-profile session cookies on Activity start and destroy (named profiles are fine).
  Single-store mode must neutralize that plugin; the config switch alone was not enough.
- Android requires `WebViewFeature.DOCUMENT_START_SCRIPT` and `WEB_MESSAGE_LISTENER`. Without
  them (WebView 53) the app shows an "unsupported WebView" state and loads no remote origin; it
  never uses `addJavascriptInterface`.
- Store deletion is deferred: iOS removes a data store after its WebView is released (with retry);
  Android records pending deletions and runs `deleteProfile` at the next cold start before any
  `getOrCreateProfile` (an in-use profile throws). Profiles are created right after add.
- Android profile WebViews handle `onRenderProcessGone`: recreate and show the error state.
- The injected script gates on `self.origin` (the document origin, `"null"` when opaque), never
  `location.origin`; the native check stays the boundary. Stored origins are normalized
  (lowercase host, punycode). Android replies "denied" on a drop, like iOS.
- Popups never get a WebView: `window.open` and `target=_blank` go to the browser sheet (§4.4) on
  both platforms.

### 15.3 The origin gate, clarified (decided 2026-11-21, spike 1.2)

Frames with an opaque origin get nothing. A same-origin unsandboxed frame or window shares the top
document's trust (same-origin policy). Core therefore keeps every iframe sandboxed without
`allow-same-origin`, enforced by a guard test. Client extensions run in the top document and see
`capybaraShell` (extensions are full trust).

Threat note: the consent page's client label is informational; the redirect allow-list is the
boundary.

### 15.4 Not measured

The back swipe and the Duo inner portrait mode could not be measured in the simulators: hand check
both on real devices before release.

### 15.5 Decisions added by the plan

1. Mobile client in the kernel: `AppAuthorizeBodySchema.client` accepts `"desktop"` and
   `"mobile"`; the session user agent is `Capybara Mobile/<appVersion> (<name>)`; the consent page
   names the client.
2. Capability shapes and limits live in `MOBILE_SHELL_LIMITS` (nav label 1..32, count 0..9999,
   menu 1..12 items, share title/text/url 256/4000/2048); the menu anchor is a CSS-px rect;
   `share@1.share` resolves `void`.
3. `chrome@1.ready` is optional; splash fallback: dropped on `ready()`, the error state, or 3 s
   after the main-frame load.
4. `data-native-nav` is set on `<html>` before first paint (and on the shell element); CSS drops
   the bottom-nav slot under either.
5. Capabilities run in the TypeScript runtime in the local Capacitor WebView; native gates frame
   and origin first, the runtime re-checks, validates and gates activation.
6. The code exchange runs in `WKContentWorld.defaultClient` on iOS and in the page world on
   Android (accepted: the same trust as the page itself).
7. In-WebView sign-in is blocked by a generated `WKContentRuleList` plus navigation cancel on iOS,
   and `shouldInterceptRequest` plus the service-worker client on Android, sharing one vector file.
8. A brand with `lockToPreset: true` wins over MDM; otherwise valid managed values override the
   brand's; while locked, other profiles are hidden and never loaded.
9. Android single-store fallback asks before switching a platform (it signs out of the current
   one).
10. Android sign-in cancel: an attempt pending on activity resume with no callback resolves
    `cancelled`.
11. Brand generation writes `Brand.xcconfig`, `brand.properties`, icon/splash sets and
    `brand-assets.sha256`; a drift check compares them.
12. Menus are custom native (action sheet with iPad popover, Material bottom sheet); haptics and
    share use the official Capacitor plugins.
13. Build number is `github.run_number`; marketing version comes from `apps/mobile/package.json`.
14. Tab icons are fixed per id (`chats`, `agents`, `inbox`, `me`) as SF Symbol / Material pairs.
15. Touch prefetch: apps/web adds `warmRoute`, which runs the route table's queries on
    `pointerdown` and when a conversation row scrolls into view.
