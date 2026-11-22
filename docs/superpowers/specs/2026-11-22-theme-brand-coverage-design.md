# Theme brand coverage: every brand graphic, every page

Issue: #451. Status: draft for review. Written against `main` at `aaf0b87af`.

Related: themes spec (`2026-11-08-themes-design.md`, the theme file, `ThemeRef`, delivery,
resolution), client extensions spec (`2026-11-09-client-extensions-design.md`, replaceable slots,
`suggestedAppearance`), bootstrap extra manifest (`2026-11-20-bootstrap-extra-manifest-design.md`
§7, the default theme from a distribution's manifest), mobile layout spec §10.2 (platform icons,
manifest), agent profile spec (`2026-11-04-agent-profile-and-new-chat-design.md`, avatar presets),
#452 (`platform.name` in every product-name string; parallel branch `feat/452-platform-name`).

## Why

A theme can set `logo.mark`, `logo.wordmark` and `logo.favicon`, and only `Logo` reads them
(`packages/design/src/display/logo.tsx:44`, `useBrand()`). With #450 a distribution ships its theme
as the platform default from the first page, so every place that still draws the capybara, and every
page rendered outside `ThemeRoot`, reads as a second product.

Verified against the code (the issue's list, with today's lines):

| Where | Code | Notes |
|---|---|---|
| Empty states | `EmptyState` → `LogoLine` (`design/src/display/empty-state.tsx:45`, `logo.tsx:78`) | about 30 call sites, incl. `DataTable`, `ItemList`, the sidebar's conversation list |
| New conversation | `Greeting` (`design/src/conversation/greeting.tsx:10`, drawn at `:71`) | the built-in of `conversation.empty` |
| Run starting | `WorkingLine` (`design/src/conversation/working-line.tsx:15-21`) | body plus walking leg frames |
| Agent avatars | preset `capybara` (`design/src/display/avatar-presets.ts:4,35`; kernel `agents/profile.ts:5`, `randomPreset` `:27`, used at `agents.service.ts:648`) | 1 in 10 new agents; first tile of the picker |
| Sign-in decoration | `Dither` (`design/src/display/graphics.tsx:20`; `templates/auth-page.tsx:51,102`) | a theme recolours it (`line`), cannot remove it |
| Kernel starting | `KernelStarting`, returned at `apps/web/src/app/(app)/layout.tsx:57` before `ThemeRoot` | an ordinary document from the layout, not an HTTP 503 |
| Root error pages | `app/error.tsx`, `app/global-error.tsx` → `components/ErrorFrame.tsx` | root providers only; `global-error` brings its own document |
| Layout 404 | `notFound()` at `(app)/layout.tsx:67` and `(auth)/layout.tsx:30` | no `app/not-found.tsx`, so Next's built-in page; `(app)/not-found.tsx` covers only `[...rest]` |
| App icons | `lib/web-manifest.ts:37,40,63`, `lib/platform-icons.ts:35-39` | upload, else the capybara PNGs |
| Browser colour | `app/layout.tsx:46-49`, `lib/web-manifest.ts:9,48-49` | built-in `PAGE_BACKGROUND` |
| Theme favicon | `lib/server/theme.ts:13`, applied by the two route-group layouts only | the pages above fall back to `app/icon.svg` |

Missed by the issue:

1. **A theme mark that fails to load** draws a broken image in `Logo` (`logo.tsx:52`): no fallback.
   It matters once pages outside the theme link assets while the kernel may be down.
2. **`AppIconSection`** (`apps/web/src/components/AppIconSection.tsx`) previews
   `DEFAULT_PLATFORM_ICONS` as "the default", which stops being true once a theme supplies one.
3. **Theme asset delivery** serves only fonts, `logo.mark` and `logo.favicon`
   (`kernel/src/themes/theme-delivery.service.ts:101-105`); every new asset must be named there.
4. **`themeColor` follows the system scheme** (`prefers-color-scheme` media entries), while the
   page's scheme follows the `cb-theme` cookie: the browser chrome is wrong whenever they differ.
5. **The avatar preset input** is also the `Platform` tool's (`PresetAvatarSchema`,
   `agents/profile.ts:53`; `platform/ops/agents.ops.ts:100`), and the admin console maps presets
   itself (`apps/web/src/lib/admin-items.ts:184`).
6. **Themes spec §7** says the root error and not-found pages "draw the built-in theme"; this spec
   amends it.

Already covered, no change: native shells read the computed `--cb-bg` and tokens for `chrome@1`
(`design/src/shell/shell-environment.tsx:149`); `(app)/error.tsx`, `(auth)/error.tsx`,
`StatusPage`, `AuthPage` and the sidebar (all three panels) sit under `ThemeRoot` and draw `Logo`.

## Goals

1. When the effective theme sets a mark, no built-in capybara is drawn anywhere: empty states,
   greeting, working line, and new avatars (presets a theme can hide and add).
2. A theme can turn the sign-in decoration off.
3. Every page the web serves renders under a theme: the kernel-starting frame, the root error pages
   and a new root 404, with a fallback chain that works when the kernel is down.
4. App icons and browser colours follow the platform default theme unless the super admin uploaded
   icons.
5. Without a theme, every pixel stays as today (built-in visual baselines unchanged).

## Non-goals

- Product-name text (#452: messages, IM phrases, OAuth `client_name`, attribution). This spec only
  points the remaining brand *text* (`Logo`'s `alt`) at #452's product name.
- Exposing the brand to plugin client code (`@capybara-hq/plugin-client` stays unchanged; a
  replacement component that wants the mark can be an additive change later).
- Native shells' own packaged icons and splash screens (clients repository).
- A service worker or offline page.
- Arbitrary theme illustrations elsewhere: design spec §3 "no illustrations" keeps holding.

## Approaches

| Approach | Verdict |
|---|---|
| **A. Declarative theme fields, drawn by the design system** (chosen) | Works for bootstrap themes (no client code, #450), for org uploads (no trust decision) and on admin and auth pages, where no plugin code runs |
| B. Client extensions replacing slots (what `theme-cyberpunk` does for `conversation.empty`) | Covers only the three replaceable slots, needs code, and bootstrap plugins cannot ship client code |
| C. Derive everything from `logo.mark` | Enough for empty state, greeting and working line (they need no new field); app icons, avatars and the decoration still need their own |

For pages outside the theme:

| Approach | Verdict |
|---|---|
| **1. A brand cookie written by the browser** (chosen) | Travels with the browser's HTTP cache: a browser that has the cookie rendered the theme and holds its immutable CSS and assets, so they load even with the kernel down; no server state |
| 2. A per-replica cache (memory or file next to the web server) | Empty on a fresh replica, differs between replicas (multi-replica rule), and the browser still cannot fetch kernel assets it never cached |
| 3. Built-in only (today) | The failure this issue reports |

## Design

### 1. The theme file (SDK contract)

New optional fields in `themes/<id>.json` (`ThemeFile`, `ThemeFileSchema`, `theme.v1` JSON Schema):

```jsonc
{
  "logo": {
    "mark": "./logo.svg", "wordmark": "ACME", "favicon": "./favicon.svg",
    "illustration": "./empty.svg",          // new: the empty-state art
    "appIcon": "./app-512.png",             // new: apple-touch and manifest `any`
    "appIconMaskable": "./app-mask-512.png" // new: manifest `maskable`
  },
  "decoration": "none",                     // new: "dither" (default) | "none"
  "avatars": [                              // new: extra agent avatar presets
    { "id": "acme-bot", "name": { "en": "Acme bot", "zh": "Acme 机器人" }, "file": "./avatars/bot.png" }
  ],
  "hideAvatarPresets": ["capybara"]         // new: built-in presets not offered
}
```

Rules (checked by `parseThemeFile` / `validateThemeAssets`, so by `capybara-plugin check`
`theme-invalid` / `theme-asset`, `pack`, and the kernel's import review):

- `illustration`: the `mark` rules (SVG ≤ 128 KB re-serialized by the sanitizer, or PNG ≤ 256 KB,
  ≥ 64 px high).
- `appIcon`, `appIconMaskable`: PNG only (the manifest and iOS need raster), square, ≥ 512 px,
  ≤ 1 MiB (the platform icon upload's limit). `appIconMaskable` requires `appIcon`.
- `avatars`: ≤ 12; `id` `^[a-z0-9][a-z0-9-]{0,31}$`, unique, not a built-in id; `name` a localized
  name (≤ 24 characters each, the wordmark's character rules); `file` square SVG (sanitized) or PNG
  ≥ 64 px, the `mark` size limits.
- `hideAvatarPresets`: built-in ids only (the SDK gains `BUILTIN_AVATAR_PRESET_IDS`; the kernel's
  `PRESET_IDS` becomes that export, and a `tools/checks` unit test keeps the design package's
  `AVATAR_PRESET_IDS` equal to it, as the design package imports no SDK); hiding all ten requires
  at least one `avatars` entry.
- `decoration`: `"dither" | "none"`, omitted = `dither`.
- The new assets count toward the 16 MB per-plugin theme asset limit.

### 2. `ThemeRef` and delivery (kernel)

- `ThemeRef.logo` gains `illustrationUrl`, `appIconUrl`, `appIconMaskableUrl` (null when unset).
- `ThemeRef` gains `decoration` and `background: { dark?: string; light?: string }`, the merged `bg`
  of each scheme the theme defines (canonical `#RRGGBB` / `rgba()`, computed at read from the stored
  definition and `mergeThemeSchemes`; no new stored data).
- The asset route serves every file the version names (`illustration`, `appIcon*`, `avatars[].file`
  added to the list at `theme-delivery.service.ts:101`); immutable and public as today. Avatar
  files are not in `ThemeRef`: they reach the web through §4.
- `THEME_CSS_REVISION` is unchanged (the stylesheet does not change).

### 3. Graphics in the design system

`Brand` (design context, set by `ThemeRoot` through `BrandRoot`) becomes
`{ markUrl, wordmark, illustrationUrl, decoration }`. Without a brand, or with `markUrl` and
`illustrationUrl` null, every component below renders exactly today's DOM.

- **`EmptyState`** (`page` and `panel`): draws `illustrationUrl ?? markUrl` as a CSS mask filled with
  `--cb-faint` in a fixed box (page 96 × 60, panel 64 × 40, `mask-size: contain`, centred), so a
  coloured mark still reads as the quiet line art of design spec §6.18 in both schemes and the box
  never shifts layout. `compact` stays text only.
- **`Greeting`**: draws `markUrl` as an image 20 px high (the bitmap's 28 × 20), width following
  the file, capped at 3 × the height.
- **`WorkingLine`**: draws `markUrl` at the same size with a subtle opacity pulse (the leg frames'
  period); reduced motion: static. The caption rotation is unchanged.
- **`Logo`**: on an image `error` it falls back to the pixel capybara for that mount (and the
  wordmark to the theme's text, unchanged); `alt` becomes the product name from #452's context
  instead of the literal `"Logo"` (until #452 lands, the wordmark, else `"Logo"`, as today).
- **`AuthPage`**: no `Dither` columns when `decoration === "none"`; the card and its width are
  unchanged.
- URLs reach CSS only as quoted, escaped strings in a custom property (`--cb-brand-art`), never
  concatenated into a selector or rule.

### 4. Avatar presets a theme can hide and add

- **Which theme decides**: the org's **effective default theme** (the org default, else the
  platform default), not the viewer's personal pick. Agents are shared in the org, so every member
  must see the same picker and the same random default.
- **Read**: `GET /api/v1/orgs/:orgId/themes` gains `avatars: { hidden: string[]; presets: { key,
  name, url }[] }` from that theme (`key` = `<plugin>/<theme file id>/<preset id>`). `AvatarPicker`
  takes `hidden` and `extra` props: hidden built-ins are not listed, theme presets follow the
  remaining built-ins, before the upload tile.
- **Write**: the avatar input keeps `{ kind: "preset", id }`, where `id` is a built-in id or a theme
  preset key. A built-in id is always accepted (hidden only means "not offered", so templates and
  the `Platform` tool keep working). A theme preset key is accepted only while it is in the org's
  effective default theme, else 400 `agent.avatar_unavailable` (new error code, with the next step
  "choose one of the presets the picker shows"). It is stored **pinned**:
  `{ kind: "theme", themeId, version, preset, file }`, and the agent API returns it with its `url`
  (the immutable asset URL). The web and the admin console draw it as `{ kind: "image", src }`.
- **Why pinned**: theme versions stay served after an update, a scope change or a soft delete
  (`theme-delivery.service.ts:38-44`), so a stored avatar never needs re-resolution, survives the
  theme leaving the org, and renders identically for every viewer; if the file still fails
  (an org-owned theme deleted with its org) the `Avatar` image rule draws the initial.
- **Random default** (`randomPreset`): picks among the visible built-ins plus the theme's presets of
  the org's effective default; with none visible, `null` (the initial).
- **Existing agents** keep their avatar: hiding `capybara` does not rewrite stored data.
- **`Platform` tool**: `PresetAvatarSchema.id` widens from the enum to "built-in id or theme preset
  key" in the shared schema (the parity test follows); the operation's description says where the
  keys come from (`themes.list` returns `avatars`).

### 5. Pages outside the theme

**The brand cookie.** `ThemeRoot` writes `cb-brand` after each commit whose resolved theme changes
(the browser writes it, like `cb-theme` and `cb-tz`; a server component cannot set cookies): the
drawn theme's `cssUrl`, `markUrl`, `wordmark`, `illustrationUrl`, `faviconUrl`, `decoration` and
`background`, base64url JSON with a version field, ≤ 1 KB, `Path=/`, `SameSite=Lax`, `Secure` on
https, max-age 30 days, renewed on every themed document, deleted under the built-in theme. It
holds what this browser last drew (the person's org or personal theme, or the platform default on
public pages), so an error page looks like the page it replaces. It is a hint, never an input to
access or to a kernel call.

**Its name over https** (maintainer decision 2026-11-22, #602): `__Host-cb-brand` (`Secure`,
`Path=/`, no `Domain`), so a sibling subdomain cannot plant it; over plain http, where browsers
refuse the prefix, `cb-brand`. The mode is the request's protocol (`location.protocol` in the
browser, Next's request protocol on the server, the signal the web's own cookies take `Secure`
from; a trusted proxy's `X-Forwarded-Proto` through `CAPYBARA_WEB_TRUST_PROXY`), and a request
carrying `__Host-cb-brand` counts as https. Readers take only the name of the mode, never a plain
`cb-brand` over https; over https `ThemeRoot` also deletes a stale plain `cb-brand`.

**Reading it** (`lib/brand-cookie.ts`, one codec for server and client): every URL must match the
kernel's theme delivery path (`^/api/v1/themes/<uuid>/<int>/(r<int>/theme\.css|assets/<segment>)$`,
same origin, no query, no `..`), the wordmark the SDK's wordmark rules, colours the canonical
grammar, `decoration` the enum; anything else discards the whole cookie. `apps/web` cannot import
the SDK, so the codec restates these rules, with red cases in its unit test.

**One rule for every page outside a route-group layout**, `outsideTheme()`:

1. the brand cookie, when valid;
2. else, on the server and when the kernel answers, the public platform default
   (`GET /api/v1/platform/theme`, already in the request's query client when a layout read it);
3. else the built-in theme.

A `StaticTheme` component (beside `ThemeRoot`, sharing `ThemeLink` and `BrandRoot`) links the CSS
and provides the brand from such a reference, without a query.

| Page | Renders | Source |
|---|---|---|
| `KernelStarting` (`(app)/layout.tsx:57`) | server, inside `StaticTheme` | steps 1, 3 (the kernel is not answering) |
| `app/error.tsx` | client, inside `StaticTheme` | step 1 (`document.cookie` through `useSyncExternalStore`, server snapshot null) |
| `app/global-error.tsx` | client, its own document | step 1, as for its locale and scheme today |
| `app/not-found.tsx` (new) | server, `StatusPage` 404 as `(app)/not-found.tsx` with a home link | steps 1-3 |

When the kernel is down, the theme CSS and assets come from the browser's HTTP cache (immutable,
one year); a browser without them gets the built-in tokens (the stylesheet link fails, the design
stylesheet already applies), no empty-state art (a failed mask image draws nothing) and the pixel
capybara (§3 `Logo` fallback). Nothing renders broken.

The root layout's `generateMetadata` applies the favicon of `outsideTheme()` (the cookie's, else the platform default's; amended in PR 4 so the root 404 without a cookie shows the theme it draws) as the parent icon, and the two
route-group layouts always set `icon` explicitly from their resolved theme (the theme's favicon, or
the platform / built-in one), so a stale cookie never outlives a themed document's own answer.

### 6. App icons and browser colours

- **Apple-touch and manifest icons**: platform upload > platform default theme's `appIcon` /
  `appIconMaskable` > built-in PNGs. Only the platform default counts: an installed icon belongs to
  the deployment, and the manifest is fetched without a session. `webManifest(meta, platformTheme)`
  and `platformIconsMetadata(meta, platformTheme)` take the platform theme read beside the meta read
  (one public call, deduplicated per request). The upload wins over the theme here, while the tab
  favicon keeps today's order (resolved theme > upload > built-in), because the favicon follows the
  page the person is on and the app icon is installed once.
- **`AppIconSection`** previews the effective default (the platform theme's icon when it has one,
  labelled as coming from the theme) instead of the built-in PNGs.
- **Manifest colours**: the platform default theme's `background.dark`, else its `light`, else
  `PAGE_BACKGROUND.dark` (today's value).
- **`themeColor`**: the root layout's `generateViewport` writes one colour for the scheme the page
  renders (the `cb-theme` cookie, or the theme's single scheme) from the outside-theme reference;
  the `(app)` and `(auth)` layouts' `generateViewport` override it with their resolved theme's
  `background`. A design-side effect in `ThemeRoot` / `StaticTheme` updates
  `<meta name="theme-color">` from the computed `--cb-bg` after a scheme toggle or theme switch (the
  value `chrome@1` already sends to native shells). The colours never come from a literal in
  `apps/web` (`check:web-ui`).

### 7. Caching, CSP, multi-replica

- **Caching**: theme asset and CSS routes stay `public, max-age=31536000, immutable`; the new
  assets join them. `GET /api/v1/platform/theme` stays `no-store`. Pages that read `cb-brand` are
  already dynamic (cookies), and `manifest.webmanifest` is `force-dynamic`; no new cache layer.
- **CSP**: unchanged. App pages leave `img-src` and `style-src` open (`lib/headers.ts:65`); every
  brand URL is same-origin under `/api/v1/themes/`; SVG assets keep their own
  `default-src 'none'; sandbox`. The cookie cannot inject: its URLs pass the path grammar before
  they reach an attribute or a custom property, and React escapes attributes.
- **Multi-replica**: no process state. The cookie lives in the browser; avatar checks and the random
  default read PG through `ThemesService`; theme delivery is replica-identical. No queue, job,
  lock or migration (the avatar column is JSON; the new kind needs none).

### 8. i18n, mobile, accessibility

- **i18n**: theme preset names come from the theme file (`{ en, zh? }`, zh falls back to en, as
  theme names do); the root 404 reuses the `notFound` messages; `AppIconSection` gains one zh/en key
  pair ("来自主题 {name}" / "From theme {name}"). No message names the product (#452's check).
- **Mobile size classes**: the art boxes are fixed sizes inside components that already adapt;
  `EmptyState` `panel` (sidebar drawer on compact) keeps 64 × 40; no page code changes
  (`design-breakpoint`). Status pages and the root 404 use `StatusPage`, already size-class aware.
- **Accessibility**: empty-state art, greeting mark and working-line mark stay `aria-hidden`; the
  pulse obeys `prefers-reduced-motion`; avatar tiles are named by the preset's localized name.

### 9. Coordination with #452

#452 owns every product-name string and adds a product-name value to the web (from the platform
meta query, default "Capybara"). This spec uses it in one place, `Logo`'s `alt` (§3), and does not
touch messages, `DEFAULT_PLATFORM_NAME` or kernel phrases. The wordmark stays a theme field: the
built-in wordmark `CAPYBARA` belongs to the pixel capybara (see decision 7). Whichever lands second
rebases `Logo`'s `alt` line.

### 10. Contract changes and changesets

- `@capybara-hq/plugin-sdk`: `ThemeFile` / `ThemeLogo`, `ThemeFileSchema`, `THEME_LIMITS`,
  `validateThemeAssets`, `BUILTIN_AVATAR_PRESET_IDS`. `pnpm gen:package-schemas`
  (`schemas/theme.v1.schema.json`) and `pnpm gen:sdk-api` (API report); a changeset bumping
  `@capybara-hq/plugin-sdk` (`check:sdk-api`, `check:api-changeset`).
- `@capybara-hq/plugin-client`: no change; `check:plugin-client-api` stays green as the proof.
- `@capybara-hq/plugin-tools`: `pack` ships the new assets; changeset.
- `@capybara-hq/kernel`: `ThemeRef`, delivery, avatars, error code; changeset.
- `@capybara-hq/testing`: the `fake-theme` fixture gains a brand-complete theme; changeset.
- Images (web, kernel): a changeset on `@capybara-hq/capybara`.
- Docs: themes spec §4.3, §7, §8 amendments; design spec §3, §6.16.24, §6.16.25, §6.18, §6.30;
  `writing-web-ui` (pages outside the theme, the brand cookie) and `writing-plugins` (theme fields)
  skills; the plugins repository's authoring skills follow with its SDK bump.

## Testing

- **SDK unit**: each new rule with a failing fixture (illustration limits, app icon not square /
  < 512 / SVG, maskable without app icon, avatar id clash with a built-in, duplicate id, > 12,
  unknown hidden id, all hidden without avatars, bad `decoration`); JSON Schema round trip.
- **plugin-tools**: `theme-asset` red fixture extended (non-square app icon); `pack` ships the files.
- **Kernel integration**: `ThemeRef` new fields and `background` merge; the asset route serves the
  new files and still 404s unnamed ones; avatars: a theme key accepted under the org's effective
  default and refused under another (`agent.avatar_unavailable`), stored pinned, still served after
  the theme updates or leaves the org; built-in ids accepted while hidden; random default never
  picks a hidden preset; `Platform` parity for the widened schema.
- **Design (jsdom)**: each component with and without a brand; without one, the DOM equals today's
  (guards goal 5); `Logo` image error falls back; `AuthPage` with `decoration: "none"`;
  `AvatarPicker` `hidden` / `extra`; `findNestedBoxes` unchanged.
- **Web unit**: the cookie codec (valid round trip; red: external URL, `javascript:`, query string,
  `..`, quote, oversized, wrong version); `outsideTheme()` order; `webManifest` / icon precedence
  (upload > theme > built-in); `generateViewport` per scheme.
- **Web e2e**: under the fixture theme as platform default, the root 404 links the theme CSS and
  draws the mark; `KernelStarting` and `app/error.tsx` render the cookie's theme (an unavailable
  shell driven by stopping the fake kernel answer, or a component test where e2e cannot); the manifest lists the theme's icons.
- **Visual**: built-in baselines must not change (a `visual` run with no diffs is the check). New
  cases under the fixture theme (empty state page and panel, greeting, working line still, auth
  page without decoration, avatar picker with theme presets, root 404) are rendered only by the
  `visual-update` workflow, closing themes spec §16 M2; new `/dev/ui` states go to the reference set
  through `reference-update`.
- New unit tests join their checked-in lists in the same PR.

## Rollout / PR split

1. **Contract** (SDK, plugin-tools, kernel delivery and `ThemeRef`, `fake-theme`): the theme fields,
   rules, schema, API report, asset route, `background`. No visible change. Changesets: plugin-sdk,
   plugin-tools, kernel, testing.
2. **Graphics** (design + web `ThemeRoot`): `Brand` fields, `EmptyState`, `Greeting`, `WorkingLine`,
   `Logo` fallback, `AuthPage` decoration; design spec sections. Depends on 1.
3. **Avatars** (kernel + design + web + `Platform`): hidden and theme presets, pinned storage,
   random default, error code. Depends on 1; independent of 2.
4. **Pages outside the theme** (web): brand cookie, `StaticTheme`, `KernelStarting`, root error
   pages, root 404, favicon parent, app icons, manifest colours, `themeColor`, `AppIconSection`.
   Depends on 1 and 2.
5. **Plugins repository**: SDK bump (with the pnpm override that keeps one SDK instance), optional
   `theme-cyberpunk` app icon and `hideAvatarPresets`; release.

Each core PR stays within one area so 2 and 3 can run in parallel after 1.

## Specs amended

- Themes spec §4.3 (logo fields), §4 (avatars, decoration), §7 ("before sign-in" and the root
  pages: `outsideTheme()` instead of "the built-in theme"), §8 (`ThemeRef` fields, the brand
  cookie), §16 M2 (closed by PR 4's visual cases).
- Mobile layout spec §10.2 (icon and colour precedence).
- Agent profile spec (presets: hidden, theme presets, pinned storage, random default).
- Design spec §3, §6.16.24, §6.16.25, §6.18, §6.30 (in PRs 2 and 3).

## AGENTS.md rules touched

- **Web UI**: pages stay template + design components; every new graphic is drawn by the design
  package, `apps/web` writes no styles or colour literals (`check:web-ui`); the root 404 is a thin
  page on `StatusPage`. No AGENTS.md change.
- **Mobile and shells**: adaptation stays in design components; no width logic in pages
  (`design-breakpoint`). No change.
- **Multi-replica discipline**: no process state; the cookie is per browser, the avatar checks read
  PG; rejected approach 2 is exactly the in-process state the rule forbids. No change.
- **Language**: preset names localized from the theme file; new UI text through zh and en messages
  (`check:i18n`). No change.
- **Public API reports**: SDK changes ship `pnpm gen:sdk-api` and a plugin-sdk changeset;
  plugin-client unchanged, `check:plugin-client-api` proves it. No change.
- **Platform tool**: the avatar input widens in the shared route schema, so the parity test follows;
  no new route, no new exclusion. No change.
- **Extensions / plugins and the catalog**: themes stay declarative data with no code; bootstrap
  themes (#450) gain coverage without client code. No change.
- **Before 0.1.0**: the avatar's stored shape gains a kind without a compatibility layer; no
  migration. No change.

## Decisions for the reviewer

**Accepted 2026-11-22 by the maintainer:** every recommendation below.

1. **What the brand cookie holds**: the theme this browser last drew (recommended: an error page
   looks like the page it replaces). Alternative: the platform default only (simpler story, but a
   person in a branded org sees the platform look on every restart).
2. **Kernel-down fallback**: a browser-written cookie, relying on the browser's immutable cache for
   assets (recommended). Alternatives: a per-replica web cache of the platform theme and its asset
   bytes (works for new browsers, but process state per replica and copies of kernel assets in the
   web), or built-in only.
3. **Which theme decides avatar presets**: the org's effective default theme (recommended: one
   picker per org, since agents are shared). Alternatives: the union of all themes on in the org;
   the viewer's resolved theme (members would see different pickers).
4. **Theme avatar storage**: pinned to the theme version's immutable asset (recommended: no
   re-resolution, survives theme removal). Alternative: a live reference re-resolved per read, which
   falls back to the initial when the theme leaves (the issue's wording), at the cost of a lookup on
   every agent read and in the admin console.
5. **Hidden built-in presets on existing agents**: keep drawing them (recommended: no data rewrite).
   Alternative: draw hidden presets as the initial everywhere.
6. **Empty-state art from a mark or illustration**: a mask filled with `faint` (recommended: keeps
   §6.18's quiet tone in both schemes; no readability check exists for images). Alternative: draw
   the file as is, letting a theme bring colour.
7. **Built-in wordmark with `platform.name` set**: keep `CAPYBARA` beside the pixel capybara
   (recommended: the pair is the built-in logo; text names belong to #452). Alternative: upper-case
   `platform.name` as the built-in wordmark.
8. **App icon precedence**: upload > platform theme > built-in, while the tab favicon keeps theme >
   upload (recommended: an installed icon is the deployment's and is set once). Alternative: theme
   wins for both, as the favicon does today.
9. **`themeColor` source**: the rendered scheme's theme background, updated client-side on toggle
   (recommended; also fixes the system-scheme mismatch). Alternative: keep the two media entries
   and only swap their colours for the theme's.
10. **New theme fields vs only `logo.mark`**: add `illustration`, `appIcon`, `appIconMaskable`,
    `avatars`, `hideAvatarPresets`, `decoration` (recommended, approach A). Alternative: drop
    `illustration` (the mark covers the empty state) to keep the format smaller.
