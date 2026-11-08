# Themes: plugins restyle the web through design tokens

- Date: 2026-11-08, written against `main` at `180e4bd4`.
- Status: reviewed by the maintainer (2026-11-08); §6-§10 adjusted to the code on 2026-11-08
  while writing the plan.
- Related: plugin component management (`2026-11-05-plugin-component-management-design.md`: owner,
  scope, components at deployment level, org uploads), platform / org layering
  (`2026-11-07-platform-org-layering-design.md`: platform values an org may override), the
  `Platform` tool (`2026-11-07-platform-tool-design.md`, `check:platform-ops`), run context
  (`2026-11-08-run-context-design.md`: `/account/preferences`), the design spec
  (`docs/design/spec.md` §2 tokens, §3 brand), the web SSR and query cache specs.
- Markers: **(decided, 2026-11-08)** is the maintainer's answer in the 2026-11-08 discussion;
  **(designer's call)** is decided here and may be overturned in review. Items without a marker
  restate current code or AGENTS.md rules.

## 1. Why

The maintainer wants a deployment to be able to customize the web end to end, the way people
restyle the DeepSeek Harness (DSH) web UI. A study of the best-known DSH restyle, the
`dsh-theme-cyberpunk2077` plugin, showed two layers:

1. **One official API**: `ctx.theme.register({ id, colorScheme, tokens })` overrides DSH's design
   tokens (`--dsw-alias-*`). This gives a palette, nothing more.
2. **Everything else is raw DOM work** by a full-trust client plugin: a 400-line injected `<style>`
   with `!important`, selectors on CSS-module class fragments (`[class*='_sessionRow']`), polling
   the DOM for the composer's pending dot, overlays appended to `body`, fonts pulled from a CDN.
   It breaks whenever DSH changes its markup.

Capybara will support plugin UI changes in four layers **(decided, 2026-11-08)**, each turning one
of those hacks into a contract:

| Layer | What a plugin can do | Document |
|---|---|---|
| **L0 theme** | Override design tokens, the logo and fonts; declarative, no code | this spec |
| L1 slots | Contribute schema views / sandboxed embeds to a versioned slot registry (generalizing today's `ctx.ui` places) | slot registry spec (next) |
| L2 client components | Ship a browser bundle that renders React components in slots, full trust | client extension direction doc |
| L3 decoration | Stable style hooks, an overlay slot, client run events | client extension direction doc |

L0 comes first: most "make it look like ours" requests are colors, fonts and a logo, and a
declarative theme carries no code, so it needs no trust decision.

## 2. Goals, non-goals, anti-goals

Goals:

1. A plugin can carry **themes**: overrides of an allowlisted set of design tokens for the dark
   and / or light scheme, plus fonts and a logo it packs itself.
2. Themes are **components** under the plugin component model: owner, scope, deployment-level
   rows, updates with their plugin.
3. **Three levels choose the theme**: a platform default (super admin), an org default (org admin),
   and the person's own pick among the themes on in their org.
4. **An org-uploaded theme takes effect without the super admin's confirmation (decided,
   2026-11-08)**: it contains no code.
5. The first paint is already themed (server-rendered, no flash), on the auth pages too.
6. No theme can make the UI unreadable: the contrast and separation floors of `tokens.json` hold
   for every theme, checked at pack time and at import.

Non-goals:

- Layout, component or markup changes (L1-L3).
- Arbitrary CSS. A theme is data the kernel turns into CSS; it never carries CSS text.
- Overriding sizes, spacing, type scale, layout widths, layering or motion: they keep the
  layout working and are not brand.
- Overriding the agent avatar palettes (`avatar-*`; design spec §3: their own colors).
- Per-person uploaded themes. A person picks; they do not upload.

Anti-goals (failure even if it works):

- A theme that passes the checks yet hides text or state (a `warn` badge on a `warn`-coloured
  ground, an `accent` that disappears on `bg`).
- A theme that silently stops applying after a core upgrade (a token renamed under it).
- A flash of the default theme before the chosen one.

## 3. Terms (UI)

| Term | Meaning |
|---|---|
| 主题 Theme | The component this spec adds |
| 配色 Scheme | Dark or light; today's account-row toggle (`cb-theme` cookie, `data-theme`) |
| 外观 Appearance | The settings section where themes are chosen (platform, org, personal) |

The cookie and attribute keep their names (`cb-theme`, `data-theme`) although they hold the scheme
(designer's call: renaming them buys nothing and breaks saved cookies).

## 4. The theme file

A plugin carries themes as `themes/<id>.json` (the id is the file's base name,
`CATALOG_ITEM_NAME_RE`). `plugin.json` gains an optional `themes: [{ path }]`; omitted means "scan
`themes/*.json`", as for skills, connectors and agents. A plugin may now consist of themes only;
the "carries nothing" check counts them.

```jsonc
{
  "name": { "en": "Night City", "zh": "夜之城" },
  "description": { "en": "Neon yellow on deep blue-black." },
  "schemes": {
    "dark": {
      "color": { "bg": "#05070D", "panel": "#0A0E18", "accent": "#FCE300", "on-accent": "#141200" },
      "shadow": { "shadow-1": "0 0 12px rgba(0,240,255,.25)" },
      "radius": { "sm": 0, "md": 2 }
    }
  },
  "fonts": [
    { "family": "MiSans", "file": "./fonts/MiSans-Regular.woff2", "weight": 400, "role": "prose" }
  ],
  "logo": { "mark": "./logo.svg", "wordmark": "NIGHT CITY" }
}
```

### 4.1 Schemes and tokens

- `schemes` has `dark`, `light` or both. A theme with one scheme is **single-scheme**: while it is
  active the account-row scheme toggle is hidden and the page renders in that scheme (the
  cyberpunk case) (designer's call).
- Each scheme is a **partial** override: tokens it leaves out keep the built-in value of that
  scheme. The kernel merges the override onto `tokens.json` before checking and rendering.
- Overridable tokens (designer's call; the allowlist is generated from `tokens.json` by
  `gen:tokens`, so a new token is not overridable until listed):
  - `color`: every color token except `avatar-*`;
  - `shadow`: every shadow token;
  - `radius`: `sm`, `md`, `bubble` (0-16 px, integers);
  - fonts through `fonts[].role` (§4.2), not as raw family strings.
- Value grammar: the grammar `tokens.json` already uses (`#RRGGBB`, `rgba(r,g,b,a)`, shadows as
  offset / blur / spread / one such color). The kernel parses every value and renders it from the
  parsed form, so no string from a theme reaches CSS as typed (no injection through a value).
- Tokens that `tokens.json` derives from another (the builder lists them, e.g. `accent-tint` from
  `accent`) are re-derived from the overridden source unless the theme sets them too.
- An unknown token name is an error, not a warning: a token removed or renamed in core makes the
  theme fail `capybara-plugin check` and the import review instead of silently doing nothing
  (anti-goal 2). Renaming a token in core therefore needs a note in the release notes and,
  after 0.1.0, a compatibility map (the builder decides the form when the first rename happens).

### 4.2 Fonts

- `fonts[]`: up to 8 entries, each a `woff2` file inside the plugin (≤ 2 MB each, checked by the
  `wOF2` signature), a `family` (letters, digits, spaces, `-`; ≤ 64 characters), `weight`
  (100-900), optional `style` (`normal` / `italic`) and a `role`: `prose` (the `--cb-font-prose`
  stack) or `mono` (`--cb-font`, the UI's body font, design spec §2.2).
- The kernel puts the family first in that role's stack, before the built-in families, so missing
  glyphs fall back to Sarasa / Inter / Source Han (CJK coverage stays).
- No remote fonts (the cyberpunk theme's jsDelivr `@import` has no equivalent): assets come only
  from the plugin.

### 4.3 Logo

- `logo.mark`: an SVG (≤ 128 KB) or PNG (≤ 256 KB, ≥ 64 px high). It replaces the pixel capybara in
  the sidebar, the rail, the auth pages and the empty states that draw it (design spec §3). The
  design system sizes it to the slot; the file's own `width` / `height` are ignored.
- SVG rules (designer's call, the same spirit as DSH's icon checks): the root is an `svg` element
  in the SVG namespace with a `viewBox`; no `script`, `foreignObject`, `style` element or
  attribute, event-handler attribute, or `href` / `xlink:href` outside the document (`#id`
  only). The kernel re-serializes the parsed tree; it never serves the uploaded bytes.
- `logo.wordmark`: optional text (≤ 24 characters, no control or format characters) replacing
  `CAPYBARA`. Omitted keeps `CAPYBARA`. A theme may replace both the mark and the wordmark
  **(decided, 2026-11-08: everything is customizable)**.
- `logo.favicon`: optional square SVG or PNG for the browser tab icon; omitted keeps today's.

### 4.4 Limits

A theme file ≤ 64 KB; ≤ 10 themes per plugin; a plugin's theme assets ≤ 16 MB in total
(designer's call; the builder adds them to the SDK limits beside skills and agents).

## 5. Readability checks

`tokens.json` lists `contrast` pairs (`[fg, bg, floor, over?]`) and `separation` triples
(`[ground, surface, floor]`), checked today by `check:tokens` for the built-in theme only.

- The pure functions (`contrastRatio`, `compositeOver`, `oklabL`, the pair evaluation) move from
  `tools/checks/src/tokens.ts` into `@capybara-hq/plugin-sdk` as `checkThemeReadability(merged)`.
  The pair lists are generated into the SDK by `gen:tokens` (the SDK imports no other package);
  `check:tokens` keeps checking the built-in theme with the same function and fails when the
  generated SDK copy is stale.
- They run on the **merged** scheme (override + built-in values), for every scheme the theme
  defines, so changing `bg` alone still has to keep `muted` readable on it.
- Where they run: `capybara-plugin check` (rule `theme-readability`, plus `theme-invalid` and
  `theme-asset` for the file and asset rules), and the kernel's import review, which refuses the
  plugin with `theme.unreadable` listing each failing pair and its ratio. A failing theme is never
  installed partially: the plugin's review fails as a whole, as for any invalid component.
- Accent rules (design spec §2.3, the five roles) are about where the accent is used, not its
  value, so they hold for every theme unchanged.

## 6. Themes as components

Themes join skills, connector templates and agent templates as a component kind under the plugin
component model (`2026-11-05-plugin-component-management-design.md`):

- **Rows**: themes come only from plugins, so every theme is a deployment-level row
  (`platform_themes` / `platform_theme_versions`, like `platform_agent_templates`) with versions,
  plugin provenance and the owner columns of org-owned items (`owner_org_id`, `origin_org_id`,
  `shareable`): an org-uploaded theme is such a row with its org as owner, as org-uploaded skills
  and agent templates already are.
- **Assets**: a theme version's parsed definition is stored in its version row; its fonts and
  logo in object storage under `deployment/platform/themes/<id>/<version>-<catalogVersion>/`
  (the `platform/<kind>/` + `syncVersionPrefix` convention of the other components). Org deletion
  follows the existing ownership rules (shared items pass to the platform, the rest go).
- **No custom-content gate**: themes are not covered by `customSkills` / `customConnectors`; an
  org upload carrying only themes passes `assertCustomContent`.
- **Scope**: `all` / `optional` / `named` and the org switch apply as for any component. "On in an
  org" means the theme is offered in that org's pickers (rule 11 of §5 there: content components
  are offered, not forced).
- **Org upload (decided, 2026-11-08)**: an org admin uploads a theme-carrying plugin without an
  extension and it is installed at once, owned by the org, scope `named: [org]` (the existing
  §4.2 branch); no super admin confirmation.
- **Names**: theme ids are unique in an org's usable set; a collision refuses the action that
  would create it, listing the conflicting items (rule 10 of §5 there).
- **Losing access**: when a theme stops being available to an org (scope change, disable,
  uninstall), every level that chose it falls back (§7); the preview of that change lists the
  orgs whose default it is and the number of people who picked it.
- **Updates**: a theme updates with its plugin; the new version is rechecked (§5), and a failing
  one blocks the plugin update with the same refusal.

## 7. Which theme applies

Three levels, most specific first:

| Level | Who sets it | Stored in | Choices |
|---|---|---|---|
| Person | the person, in 个人设置 › 偏好设置 › 外观 | `accounts.theme` (new column; null = follow the org) | themes on in the current org, or 默认 |
| Org | org admins, in 组织设置 › 外观 | `orgs.settings.theme` (`{ id: string \| null, personal: "allowed" \| "locked" }`; `OrgSettingsSchema`) | themes on in the org, or 跟随平台 |
| Platform | the super admin, in 平台设置 › 外观 | `deployment_settings` key `uiTheme` (`{ id: string \| null }`; `DEPLOYMENT_SETTINGS`) | platform-owned themes with scope `all`, or the built-in theme |

- Resolution for a signed-in page: the person's pick if it is on in the current org and the org
  does not lock; else the org's default if on; else the platform's default if on in the org;
  else the built-in theme. An unavailable choice is skipped, never an error.
- **Lock (designer's call)**: `personal: "locked"` hides the personal picker in that org (a
  company that mandates its brand). The scheme toggle stays unless the resolved theme is
  single-scheme.
- The person's pick is one value for the person, across all their orgs, not one per org
  **(decided, 2026-11-08)**; in an org where it is not on (or that locks), the org's default
  applies.
- **Before sign-in** (auth pages, `/invite`, errors outside the workspace): the platform default.
  Only platform-owned `all` themes can be the platform default, so nothing org-specific leaks to
  an anonymous page.
- The platform default can only be a platform-owned theme whose scope is `all` **(decided,
  2026-11-08)**: a default that is off in some org would make that org's fallback differ from the
  auth pages. Narrowing the scope of the theme that is the platform default, disabling it, or
  uninstalling or deleting its plugin is refused until another default is chosen
  (`theme.platform_default`, 409, naming the setting), whether the theme follows its plugin's scope
  or has its own.

## 8. Delivering a theme to the web

- **CSS from the kernel**: `GET /api/v1/themes/:id/:version/theme.css` renders, from the stored,
  parsed theme, the overrides under `:root[data-theme="dark"]` / `:root[data-theme="light"]`, the
  `@font-face` rules and the font stacks. A single-scheme theme writes its one scheme under both
  selectors and pins `color-scheme`, so it needs nothing from the root layout (which owns
  `<html data-theme>` from the `cb-theme` cookie and cannot see the workspace's data).
  Asset routes `GET /api/v1/themes/:id/:version/assets/:file` serve the re-serialized logo and the
  fonts. Both are immutable per version (`Cache-Control: public, max-age=31536000, immutable`)
  and identical on every replica (rendered from PG / object storage; no process state).
- **Access**: every theme's CSS and assets are public, without a session **(decided,
  2026-11-08: styles are not sensitive)**. The URLs carry the theme id and version, so they reveal
  only that such a theme exists; the listing of an org's themes (§9) stays members-only.
- **SSR**: the workspace layout's shell read (`getShell`) gains, in parallel with its other org
  reads, `GET /api/v1/orgs/:orgId/themes` (§9), whose `resolved` is the viewer's theme
  (`{ id, version, schemes, logo } | null`). The layout renders
  `<link rel="stylesheet" href=… precedence="theme">` after the design stylesheet (React hoists
  it into `<head>` and the streamed document waits for it; the builder confirms this holds with
  the layout's streaming and the query cache's dehydration), so the first paint is themed. The
  auth layout reads the public `GET /api/v1/platform/theme` the same way.
- **Changes**: setting a theme at any level invalidates the themes read (`useAppMutation`), the
  link swaps, and the browser loads the new immutable stylesheet. Another tab follows its
  freshness class; an org switch re-reads as today.
- **Logo**: the design system draws the logo inside its own components (the sidebar, `AuthPage`,
  `StatusPage`), so the resolved theme's `{ markUrl, wordmark }` reaches them through the design
  context (`DesignProvider`, a new `brand` value set by the web's `design-root`); `Logo` keeps its
  props (`wordmark` stays the boolean "draw the wordmark") and reads the brand from the context.
  Without a brand, the pixel capybara and `CAPYBARA` as today.

## 9. APIs and the `Platform` tool

| Route | Guard | Purpose |
|---|---|---|
| `GET /api/v1/orgs/:orgId/themes` | member (`org.read`) | `{ themes, resolved }`: themes on in the org (id, version, name, swatches) and the viewer's resolved theme |
| `PATCH /api/v1/orgs/:orgId/settings` | existing (`org.update`) | gains `theme` (the org default and lock) |
| `PUT /api/v1/admin/settings` | existing (`@SuperAdmin`) | gains `uiTheme` (the platform default) |
| `PUT /api/v1/me/preferences` | signed in | gains `theme: string \| null`; becomes a partial update: each field is optional and an omitted field keeps its value |
| `GET /api/v1/platform/theme` | public | the resolved platform default for anonymous pages |
| `GET /api/v1/themes/:id/:version/theme.css`, `…/assets/:file` | public | delivery |

- The settings already have `Platform` operations (`platform.set-preferences`,
  `org-settings.update`, `admin.update-settings`); they gain the fields, so an agent can switch a
  person's or an org's theme on request ("change my theme to Night City"); the org and platform
  writes stay confirmed and never rememberable. The listing gets a new operation (`themes.list`).
  The delivery routes and `GET /api/v1/platform/theme` are excluded as `transport`.
  `check:platform-ops` enforces this. The public routes join `PUBLIC_ROUTES`
  (`packages/kernel/test/identity/public-routes.test.ts`).
- Error codes: `theme.invalid`, `theme.unreadable` (import), `theme.not_available` (a `PUT` naming
  a theme that is not on where it is set; 400), `theme.platform_default` (§7; 409).

## 10. Pages

- **平台设置 › 外观** (super admin): the platform default, a card per eligible theme with swatches
  of `bg` / `panel` / `ink` / `accent` for each scheme, and 内置主题.
- **组织设置 › 外观** (org admins; members read only, per roles everywhere): the org default and
  允许成员自选 (the lock).
- **个人设置 › 偏好设置 › 外观**: the person's theme cards (hidden when locked, with one line
  saying the org sets it) above today's time zone.
- **Admin component page**: 主题 at `/admin/themes` (+ `/admin/themes/<id>`), beside the existing
  per-kind pages (技能, 连接器模板, 智能体模板), with their owner tabs, scope, versions, and where it
  is a default.
- **Org**: the org's themes and their switches are listed in 组织设置 › 外观 above the default.
- **Account row**: the scheme toggle as today, hidden under a single-scheme theme.

All pages are templates + design components (`check:web-ui`); the swatches are a new design
component (`ThemeSwatch`), whose colors come from the theme's data, not from literals in pages.

## 11. Design spec changes

- §2: tokens stay the only way to color; add "a theme may override the allowlisted tokens (§2.x);
  the contrast and separation floors hold for every theme".
- §3: the logo and wordmark may be replaced by the resolved theme; the pixel capybara is the
  built-in theme's logo. "No illustrations, gradients, frosted glass" stays for the built-in UI and
  for themes (a theme has no way to add them; L3 is where decoration goes).
- §2.3 (accent roles) unchanged.

## 12. What does not change

- Not model-visible: no event, no `DriftReason`; replays are unaffected.
- No extension code runs; the extension trust model is untouched.
- `apps/web` still writes no styles: the theme stylesheet is served by the kernel and linked by
  the layout, and `check:web-ui` rules stay as they are.

## 13. Tests

- SDK: theme parsing (every rule of §4 with a failing fixture), `checkThemeReadability` on merged
  schemes, SVG sanitizer cases (script, foreignObject, external href, style attribute).
- `capybara-plugin check`: red fixtures for `theme-invalid`, `theme-readability`, `theme-asset`.
- `check:tokens`: red fixture for a stale generated SDK copy of the pair lists and the allowlist.
- Kernel: import review refusals; resolution order (person / org / platform / built-in, lock,
  unavailable choices); CSS rendering from parsed values
  (a value with `;}` or `</style>` never reaches the output); org deletion keeps shared themes.
- Testing package: a declarative `fake-theme` fixture plugin (themes only); `packFixture` accepts
  it beside the fake extensions.
- Web: an e2e test sets an org theme and reads a token's computed value on the first document
  (no client-side swap); the visual suite gets one page rendered under the fixture theme.

## 14. Phases

1. SDK format, readability check, `capybara-plugin check` rules, `gen:tokens` outputs.
2. Kernel: component rows, import, storage, delivery routes, resolution, settings routes,
   `Platform` mirrors.
3. Web: SSR link, the brand in the design context, the three 外观 sections, `/admin/themes`.

## 15. Review decisions

Answered on 2026-11-08, no open questions left: the platform default is `all`-only (§7); the
personal pick is per person, not per org (§7); a theme may replace the wordmark as well as the
mark (§4.3); every theme's CSS and assets are public (§8).
