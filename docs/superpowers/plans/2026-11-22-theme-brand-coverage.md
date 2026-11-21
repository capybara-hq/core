# Theme brand coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task, with the wave layer of `.agents/skills/wave-planned-subagent-development/SKILL.md`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the effective theme sets a brand, no built-in capybara is drawn anywhere, every page
the web serves renders under a theme (also with the kernel down), and app icons and browser colours
follow the platform default theme (#451).

**Architecture:** The theme file gains declarative brand fields (`logo.illustration`, `logo.appIcon`,
`logo.appIconMaskable`, `decoration`, `avatars`, `hideAvatarPresets`) checked by the SDK; the kernel
serves the new assets and extends `ThemeRef`; the design system draws every graphic from the
`Brand` context; avatar presets come from the org's effective default theme and are stored pinned
to an immutable asset; pages outside a route-group layout read a browser-written `cb-brand` cookie
through one rule, `outsideTheme()`.

**Tech Stack:** TypeScript, zod 4, NestJS, Kysely, PostgreSQL, vitest (node, jsdom), Next.js App
Router (React 19), TanStack Query, Playwright (e2e, visual).

**Spec:** `docs/superpowers/specs/2026-11-22-theme-brand-coverage-design.md` (PR #549, every
recommendation of "Decisions for the reviewer" accepted 2026-11-22). Section numbers `§n` below are
the spec's.

This plan names files, interfaces, test cases and commands; it holds no implementation code (the
implementer writes it test first).

## Global Constraints

- Theme file fields (all optional): `logo.illustration` (`.svg` / `.png`, the `mark` rules: SVG
  ≤ 128 KB after the sanitizer, PNG ≤ 256 KB and ≥ 64 px high); `logo.appIcon`,
  `logo.appIconMaskable` (PNG only, square, ≥ 512 px, ≤ 1 MiB; `appIconMaskable` requires
  `appIcon`); `decoration: "dither" | "none"` (omitted = `dither`); `avatars` (≤ 12 entries
  `{ id, name: { en, zh? }, file }`, id `^[a-z0-9][a-z0-9-]{0,31}$`, unique, not a built-in id,
  each name ≤ 24 characters with the wordmark's character rules, file square SVG (sanitized) or PNG
  ≥ 64 px with the `mark` size limits); `hideAvatarPresets` (built-in ids only; hiding all ten
  needs at least one `avatars` entry). New assets count toward the 16 MB per-plugin limit.
- Built-in avatar ids: `BUILTIN_AVATAR_PRESET_IDS` in the SDK (`capybara`, `black-bear`, `panda`,
  `elephant`, `fox`, `owl`, `penguin`, `rabbit`, `turtle`, `whale`, this order); the kernel's
  `PRESET_IDS` is that export; the design package's `AVATAR_PRESET_IDS` stays a copy, kept equal by
  a `tools/checks` test.
- Theme preset key: `<plugin>/<theme file id>/<preset id>`; stored avatar
  `{ kind: "theme", themeId, version, preset, file }`, returned with `url` (the immutable asset URL).
- New error code: `agent.avatar_unavailable` (400), next step "choose one of the presets the picker
  shows".
- Brand cookie: name `cb-brand`, base64url JSON with `v: 1`, ≤ 1 KB, `Path=/`, `SameSite=Lax`,
  `Secure` on https, max-age 30 days (2592000 s), deleted under the built-in theme. URLs must match
  `^/api/v1/themes/<uuid>/<int>/(r<int>/theme\.css|assets/<segment>)$` (same origin, no query, no
  `..`); a single invalid field discards the whole cookie. A hint only: never an input to access or
  to a kernel call.
- Icon precedence: apple-touch and manifest icons: upload > platform default theme > built-in; tab
  favicon unchanged: resolved theme > upload > built-in.
- Without a theme, every pixel stays as today: the built-in visual baselines must not change.
- No migration, no queue, no lock, no process state (multi-replica rule); theme asset and CSS routes
  stay `public, max-age=31536000, immutable`; `GET /api/v1/platform/theme` stays `no-store`;
  `THEME_CSS_REVISION` unchanged; CSP unchanged.
- `apps/web` writes no styles, no colour literals (`check:web-ui`); every graphic is drawn by
  `@capybara-hq/design`; brand URLs reach CSS only as a quoted, escaped string in the custom property
  `--cb-brand-art`.
- `@capybara-hq/plugin-client` unchanged (`check:plugin-client-api` stays green as the proof).
- English for code, comments, docs and commits; UI text zh + en (`check:i18n`; no message names the
  product, #452's check).
- Public API: `pnpm gen:sdk-api` + `pnpm gen:package-schemas` + a changeset bumping
  `@capybara-hq/plugin-sdk` (minor). Changesets also for `@capybara-hq/plugin-tools`,
  `@capybara-hq/kernel`, `@capybara-hq/testing`, `@capybara-hq/design` and `@capybara-hq/capybara`
  (images) where each PR below says.
- Kernel conventions: `@Injectable`, explicit `@Inject`, `@Transactional()` writes
  (`pnpm check:kernel-conventions`). New pure kernel tests join `packages/kernel/test/unit-tests.json`
  in the same change; other kernel tests are integration by default. Design, web, SDK, plugin-tools
  and `tools/checks` tests have no checked-in list.
- Visual baselines and reference images are rendered only by the `visual-update` and
  `reference-update` workflows (`workflow_dispatch` with the PR branch); never commit local
  `*-darwin.png`.

## Review Focus

1. **Untrusted theme files** (PR 1): every new asset goes through the existing sanitizer / PNG
   reader; the asset route serves only files the stored definition names (`themeAssetRefs`), never
   another path. Tests in Tasks 1.1 and 1.4.
2. **Brand URLs into CSS and attributes** (PR 2, PR 4): a URL with a quote, backslash, newline or
   `)` cannot end the custom property's string; a cookie URL outside the delivery grammar never
   reaches the DOM. Tests in Tasks 2.1 and 4.1.
3. **Cross-tenant avatars** (PR 3): a theme preset key is accepted only while its theme is the
   org's effective default *and on in that org*; an org-owned theme of another org is refused. Test
   in Task 3.2.
4. **No pixel change without a theme**: the design jsdom tests assert today's DOM without a brand,
   and the `visual` job runs with no diffs on the built-in baselines (PR 2, PR 3).
5. **Kernel down** (PR 4): `KernelStarting`, `app/error.tsx` and the root 404 render (cookie theme or
   built-in), never a broken image. Tests in Tasks 4.3 and 4.6.

## Coordination with #452 (branch `feat/452-platform-name`)

#452 is in progress in its own worktree (uncommitted at the time of writing). Files both lines
touch:

| File | #452 | This plan |
|---|---|---|
| `apps/web/src/components/theme-root.tsx` | product name as the fallback wordmark (`useProductName()`) | Task 2.5 (Brand fields), Task 4.2 (`Themed` shared with `StaticTheme`, cookie write, theme-color) |
| `apps/web/test/theme-root.test.tsx`, `apps/web/test/support/render.tsx` | product name provider | Tasks 2.5, 4.2 |
| `apps/web/src/app/layout.tsx` | `generateMetadata` title from `DEFAULT_PLATFORM_NAME` | Task 4.4 (icons, favicon parent, `generateViewport`) |
| `apps/web/src/app/global-error.tsx` | `withProductName(messages, null)` | Task 4.3 (`StaticTheme` from the cookie) |
| `apps/web/messages/en.json`, `zh.json` | `{product}` messages | Task 4.5 (`appIcon.fromTheme`) |
| `.agents/skills/writing-web-ui/SKILL.md` | product name section | Task 4.7 (pages outside the theme) |
| `apps/web/src/lib/platform-icons.ts` (`DEFAULT_PLATFORM_NAME`) | imported by the layout | read only here (Task 4.4 edits `web-manifest.ts`) |
| `tools/checks/src/i18n.ts` | product-name rule | not edited; Task 4.5's message must pass it |
| `packages/design/src/display/logo.tsx` | not touched | Task 2.1 (`alt` from `Brand.productName`) |

Sequencing: **merge #452 before PR 2 and PR 4.** PR 1 and PR 3 share no file with #452 and run in
any order. If PR 2 lands first after all, #452 rebases `theme-root.tsx` and sets
`productName: useProductName()` in the brand (the line Task 2.5 leaves as `null`). See open
question 1 for the one conflict of substance.

---

## PR and wave outline

| PR | Branch (suggested) | Depends on | Waves |
|---|---|---|---|
| 1 Contract | `feat/451-theme-brand-contract` | spec on main | W1: 1.1 · W2: 1.2, 1.3 · W3: 1.4 · W4: 1.5 |
| 2 Graphics | `feat/451-theme-brand-graphics` | PR 1 released to the workspace (same repo, so merged), #452 | W1: 2.1, 2.6 · W2: 2.2, 2.3, 2.4, 2.5 · W3: 2.7 |
| 3 Avatars | `feat/451-theme-avatars` | PR 1 | W1: 3.1, 3.3 · W2: 3.2 · W3: 3.4 · W4: 3.5 |
| 4 Outside the theme | `feat/451-pages-outside-theme` | PR 1, PR 2, #452 | W1: 4.1 · W2: 4.2, 4.4 · W3: 4.3, 4.5 · W4: 4.6, 4.7 |
| 5 Plugins repo | `capybara-hq/plugins`: `chore/sdk-theme-brand` | PR 1 released (npm rc) | single task |

PRs 2 and 3 run in parallel after PR 1. They share one file, `apps/web/src/lib/themes.ts` (PR 2 adds
`ThemeRef` fields, PR 3 adds `OrgThemes.avatars`): the second to merge rebases it. Each PR ends with
`pnpm verify` and a whole-branch review on the most capable model.

Risk and review per task (wave skill): `high` tasks are reviewed alone on the most capable model;
the rest share one batched review per wave on a mid-tier model.

| Task | Risk | Why |
|---|---|---|
| 1.1 SDK theme fields | high | contract + untrusted file validation (sanitizer inputs) |
| 1.4 Kernel delivery + `ThemeRef` | high | public unauthenticated asset route |
| 2.1 Brand context + CSS URL | high | URL into CSS (injection) |
| 3.2 Avatar write path | high | cross-tenant rule (theme of another org) |
| 4.1 Brand cookie codec | high | untrusted cookie into attributes and CSS |
| all others | normal | |

---

## PR 1: Contract (SDK, plugin-tools, kernel delivery and `ThemeRef`, `fake-theme`)

No visible change. Changesets: `@capybara-hq/plugin-sdk` (minor), `@capybara-hq/plugin-tools`,
`@capybara-hq/kernel`, `@capybara-hq/testing` (patch).

### Task 1.1: SDK theme fields, rules and asset list (high)

**Files:**
- Create: `packages/plugin-sdk/src/avatar-presets.ts`
- Modify: `packages/plugin-sdk/src/theme.ts` (`THEME_LIMITS` :27, `ThemeLogo` :77, `ThemeFile` :87,
  zod `shape` `logo` :198)
- Modify: `packages/plugin-sdk/src/theme-assets.ts` (`readPng`/`checkPng` :356,
  `validateThemeAssets` :389-447)
- Modify: `packages/plugin-sdk/src/index.ts` (exports)
- Generated: `packages/plugin-sdk/schemas/theme.v1.schema.json` (`pnpm gen:package-schemas`),
  `packages/plugin-sdk/api/plugin-sdk.api.md` (`pnpm gen:sdk-api`)
- Test: `packages/plugin-sdk/test/theme.test.ts`, `packages/plugin-sdk/test/theme-assets.test.ts`

**Interfaces:**
- Produces:
  - `BUILTIN_AVATAR_PRESET_IDS: readonly ["capybara", …, "whale"]`, `type BuiltinAvatarPresetId`
  - `THEME_DECORATIONS = ["dither", "none"] as const`, `type ThemeDecoration`
  - `THEME_LIMITS` gains `avatars: 12`, `avatarIdPattern` (as a `RegExp` export
    `THEME_AVATAR_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/`), `appIconBytes: 1_048_576`,
    `appIconMinSize: 512`
  - `ThemeLogo` gains `illustration?`, `appIcon?`, `appIconMaskable?` (asset paths)
  - `interface ThemeAvatarPreset { id: string; name: LocalizedName; file: string }`
  - `ThemeFile` gains `decoration?: ThemeDecoration`, `avatars?: ThemeAvatarPreset[]`,
    `hideAvatarPresets?: BuiltinAvatarPresetId[]`
  - `themeAssetRefs(theme: ParsedTheme): { field: string; ref: string }[]`: fonts, `logo.mark`,
    `logo.favicon`, `logo.illustration`, `logo.appIcon`, `logo.appIconMaskable`,
    `avatars.<i>.file`, in that order. The one list every reader uses (plugin-tools `assetRefs`,
    kernel `catalog-content.ts:631`, kernel delivery `theme-delivery.service.ts:101`).
  - `validateThemeAssets` keeps its signature; it walks `themeAssetRefs` and checks each field by
    kind (font, logo image, favicon square, app icon PNG square ≥ 512 ≤ 1 MiB, avatar square).

- [ ] **Step 1: Failing tests** in `theme.test.ts` (`parseThemeFile`):
  - `accepts a brand-complete theme` (every new field) → parsed fields equal the input
  - `rejects appIconMaskable without appIcon` → error path `logo.appIconMaskable`
  - `rejects an SVG app icon` (`./app.svg`) → `logo.appIcon` must be `.png`
  - `rejects more than 12 avatars`, `rejects a duplicate avatar id`, `rejects an avatar id that is a
    built-in id` (`fox`), `rejects an avatar id outside the pattern` (`Bot_1`)
  - `rejects an avatar name over 24 characters` and `with a forbidden character` (same message as
    the wordmark)
  - `rejects an unknown hidden preset` (`dragon`)
  - `rejects hiding all ten built-ins without avatars`; `accepts hiding all ten with one avatar`
  - `rejects decoration "stars"`; `decoration omitted parses as undefined` (default applied by readers)
  - `the JSON Schema accepts the brand-complete example and rejects unknown keys under logo`
- [ ] **Step 2: Failing tests** in `theme-assets.test.ts` (`validateThemeAssets`, PNG headers built
  by the file's existing helper):
  - `an illustration follows the mark rules` (PNG 63 px high → error; oversized SVG → error)
  - `an app icon must be square` (512 × 511 → `logo.appIcon: … must be square`)
  - `an app icon must be at least 512 px` (256 × 256) and `at most 1 MiB` (1 MiB + 1)
  - `an app icon may exceed the 256 KB logo PNG limit` (600 KB, 512 × 512 → no error)
  - `an avatar file must be square` (SVG viewBox 0 0 40 30; PNG 64 × 80)
  - `an avatar SVG is sanitized` (a `<script>` child is dropped; the returned bytes differ)
  - `new assets count toward assetsBytes` (sum over illustration + icons + avatars > 16 MB → error)
  - `themeAssetRefs lists every asset field in order` (exact array for the brand-complete theme)
- [ ] **Step 3: Run** `pnpm exec vitest run packages/plugin-sdk/test/theme.test.ts packages/plugin-sdk/test/theme-assets.test.ts` → FAIL.
- [ ] **Step 4: Implement**: the zod fields with cross-field rules in the existing `superRefine`
  style; `readPng` takes the byte limit as a parameter (app icon 1 MiB, logo 256 KB); export from
  `src/index.ts`.
- [ ] **Step 5: Generate** `pnpm gen:package-schemas && pnpm gen:sdk-api`.
- [ ] **Step 6: Run** the tests, `pnpm check:package-schemas && pnpm check:sdk-api` → PASS.
- [ ] **Step 7: Commit** `feat(plugin-sdk): theme brand fields, avatar presets and asset list (#451)`
  with `.changeset/theme-brand-sdk.md` (`@capybara-hq/plugin-sdk`: minor).

### Task 1.2: `fake-theme` brand-complete fixture

**Files:**
- Create: `packages/testing/fixtures/plugins/fake-theme/themes/brand-kit.json`
- Create: `packages/testing/fixtures/plugins/fake-theme/brand/illustration.svg`,
  `brand/app-512.png`, `brand/app-mask-512.png`, `brand/avatars/bot.svg`, `brand/avatars/cat.png`
- Modify: `packages/testing/fixtures/plugins/fake-theme/.capybara-plugin/plugin.json` (if it lists
  themes) and `package.json` `files` (if it whitelists)
- Test: `packages/testing/test/` existing fixture pack test, or `packages/plugin-tools/test/pack.test.ts`
  (Task 1.3 owns that file: here only run it)

**Interfaces:**
- Consumes: Task 1.1 fields.
- Produces: theme `brand-kit` (dark + light, `logo.mark` = the existing `logo.svg`,
  `illustration`, `appIcon`, `appIconMaskable`, `decoration: "none"`, `avatars` `bot` (SVG) and
  `cat` (PNG), `hideAvatarPresets: ["capybara"]`, wordmark `BRAND KIT`, distinct dark/light `bg`).
  The e2e and kernel tests name it `fake-theme/brand-kit`.

- [ ] **Step 1:** Create the PNGs once with a throwaway script (not committed): solid colour,
  512 × 512 (two files) and 64 × 64 (cat), one IDAT, each under 8 KB.
- [ ] **Step 2:** Write `brand-kit.json` and the SVGs (square viewBox for the avatar).
- [ ] **Step 3: Run** `node packages/plugin-tools/bin/capybara-plugin.mjs check packages/testing/fixtures/plugins/fake-theme`
  → no findings.
- [ ] **Step 4: Commit** `test(testing): brand-complete fake-theme fixture (#451)` with a changeset
  (`@capybara-hq/testing`: patch).

### Task 1.3: plugin-tools uses the SDK asset list

**Files:**
- Modify: `packages/plugin-tools/src/check/themes.ts` (`assetRefs` :113-117 delegates to
  `themeAssetRefs`)
- Modify: `packages/plugin-tools/src/pack/pack.ts` (:475-480 ship the files `themeAssetRefs` names)
- Create: `packages/plugin-tools/test/fixtures/plugin-theme-asset/brand/app-511.png` and a theme in
  that fixture naming it as `logo.appIcon`
- Test: `packages/plugin-tools/test/themes.test.ts`, `packages/plugin-tools/test/pack.test.ts`

- [ ] **Step 1: Failing tests:** `themes.test.ts` `a non-square app icon is theme-asset` (message
  names `logo.appIcon`); `pack.test.ts` `pack ships the illustration, app icons and avatar files`
  (pack `packages/testing/fixtures/plugins/fake-theme`, list the tgz entries).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-tools/test/themes.test.ts packages/plugin-tools/test/pack.test.ts` → FAIL.
- [ ] **Step 3: Implement**; **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plugin-tools): check and pack theme brand assets (#451)` with a
  changeset (`@capybara-hq/plugin-tools`: patch).

### Task 1.4: Kernel delivery, import and `ThemeRef` (high)

**Files:**
- Modify: `packages/kernel/src/themes/theme-delivery.service.ts` (`asset` :97-123: `named` from
  `themeAssetRefs`)
- Modify: `packages/kernel/src/catalog/catalog-content.ts` (:625-635 refs from `themeAssetRefs`)
- Modify: `packages/kernel/src/themes/theme-state.ts` (`ThemeRef` :29-48, `themeRefOf` :89-113)
- Create: `packages/kernel/test/themes/theme-ref.test.ts` (pure) and add
  `"themes/theme-ref.test.ts"` to `packages/kernel/test/unit-tests.json`
- Test: `packages/kernel/test/themes/public-routes.test.ts`, `packages/kernel/test/themes/resolve.test.ts`

**Interfaces:**
- Produces (`ThemeRef`, kernel; mirrored by the web in Task 2.5):
  - `logo: { markUrl; wordmark; faviconUrl; illustrationUrl: string | null; appIconUrl: string | null; appIconMaskableUrl: string | null } | null`
  - `decoration: "dither" | "none"` (the default applied)
  - `background: { dark?: string; light?: string }`: the merged `color.bg` of each scheme the theme
    defines (`mergeThemeSchemes`), canonical `#RRGGBB` / `rgba()`; computed at read, nothing stored.
- `ListedTheme` inherits the fields; `themes.list` and `GET /api/v1/platform/theme` return them.

- [ ] **Step 1: Failing unit tests** (`theme-ref.test.ts`, `themeRefOf` on parsed fixtures):
  `illustration and app icon URLs are delivery URLs`, `null URLs when unset`,
  `decoration defaults to dither`, `background holds the merged bg of each defined scheme only`
  (a dark-only theme has no `light` key; a theme without a `bg` override gets the built-in value).
- [ ] **Step 2: Failing integration tests** (`public-routes.test.ts`, importing `fake-theme` with
  `brand-kit`): `GET assets serves the illustration, both app icons and each avatar file with their
  types, immutable`; `an asset the definition does not name is still 404 theme.not_found`
  (a file present in the package but unnamed); `a removed theme's new assets are still served`.
  `resolve.test.ts`: `GET /orgs/:orgId/themes and GET /platform/theme carry decoration and
  background`.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/kernel/test/themes` → FAIL.
- [ ] **Step 4: Implement.** **Step 5: Run** → PASS; `pnpm check:kernel-conventions`,
  `pnpm check:test-portfolio`.
- [ ] **Step 6: Commit** `feat(kernel): serve theme brand assets; ThemeRef decoration and background (#451)`
  with a changeset (`@capybara-hq/kernel`: patch).

### Task 1.5: PR 1 docs, check and PR

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-themes-design.md` (§4.3 logo fields, §4 avatars and
  decoration, §8 `ThemeRef` fields)
- Modify: `.agents/skills/writing-plugins/SKILL.md` (theme fields), `packages/plugin-sdk/agent-docs/plugin-format.md`
  (the themes bullet names the new fields; `pnpm gen:agent-docs` if a generated table changes)

- [ ] **Step 1:** Edit the docs; `pnpm check:agent-docs`.
- [ ] **Step 2:** `pnpm verify` (full diff run) → green; `pnpm check:api-changeset --base origin/main`.
- [ ] **Step 3: Commit** `docs: theme brand fields in the themes spec and skills (#451)`; open the PR
  ("Refs #451"); after merge, the Version Packages PR publishes the SDK rc that PR 5 needs.

---

## PR 2: Graphics (design + web `ThemeRoot`)

Depends on PR 1 (and #452, see coordination). Changesets: `@capybara-hq/design`,
`@capybara-hq/capybara` (patch).

### Task 2.1: `Brand` fields, CSS URL value and `Logo` fallback (high)

**Files:**
- Modify: `packages/design/src/provider.tsx` (`Brand` :41)
- Create: `packages/design/src/display/brand-art.ts`
- Modify: `packages/design/src/display/logo.tsx` (`Logo` :35-71)
- Modify: `packages/design/src/index.ts` (exports)
- Create: `packages/design/test/brand.test.tsx`
- Modify: `packages/design/test/logo.test.tsx`

**Interfaces:**
- Produces:
  - `type Brand = { markUrl: string | null; wordmark: string | null; illustrationUrl: string | null; decoration: "dither" | "none"; productName: string | null }`
  - `cssUrlValue(url: string): string`: `url("…")` with `\`, `"`, newlines and control characters
    escaped (CSS string escapes), the one way a brand URL reaches CSS
  - `brandArtStyle(url: string): { "--cb-brand-art": string }`
  - `useBrandMark(): { src: string; failed: boolean; onError(): void } | null`: the mark with the
    per-mount fallback state (used by `Logo`, `Greeting`, `WorkingLine`)

- [ ] **Step 1: Failing tests** (`brand.test.tsx`): `cssUrlValue escapes quote, backslash and
  newline` (each input yields a value a CSS parser reads back as the same string: assert through
  `CSSStyleDeclaration.setProperty` + `getPropertyValue` round trip in jsdom); `a URL with ")" and
  ";" stays inside the string`; `brandArtStyle sets only --cb-brand-art`.
  `logo.test.tsx`: `a theme mark that fails to load falls back to the pixel capybara for that mount`
  (fire `error` on the img → svg rendered, no img); `alt is productName, else the wordmark, else
  "Logo"`; `without a brand the DOM equals today's` (snapshot of the current markup taken before the
  change, committed in the test).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/design/test/brand.test.tsx packages/design/test/logo.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** No CSS file in this task (Task 2.2 owns `display.css`).
- [ ] **Step 4: Run** → PASS; `pnpm typecheck` (callers of `Brand` in `apps/web` fail to compile
  until Task 2.5: in this wave, fill the new fields with `null` / `"dither"` in
  `apps/web/src/components/theme-root.tsx` only as a one-line compile fix, which Task 2.5 replaces).
- [ ] **Step 5: Commit** `feat(design): brand illustration, decoration and mark fallback (#451)`.

### Task 2.6: Design spec sections

**Files:**
- Modify: `docs/design/spec.md` (§3 brand elements, §6.16.24 working line, §6.16.25 greeting, §6.18
  empty state, the auth template (`template-auth` near :769)): the theme's mark / illustration, the
  mask filled with `faint` (page 96 × 60, panel 64 × 40, `mask-size: contain`, centred), the greeting
  and working-line mark 20 px high capped at 3 × the height, the pulse and reduced motion, the
  decoration switch; new states in the state lists (`empty-state`: `branded-page`,
  `branded-panel`; `greeting`: `branded`; `working-line`: `branded`; `template-auth`:
  `no-decoration`) and their size-table rows.

- [ ] **Step 1:** Edit the spec; `pnpm check:web-ui` (state-list syntax), `pnpm lint`.
- [ ] **Step 2: Commit** `docs(design): theme brand graphics in the design spec (#451)`.

### Task 2.2: `EmptyState` art

**Files:**
- Modify: `packages/design/src/display/empty-state.tsx` (art span :45-49)
- Modify: `packages/design/src/styles/display.css` (`.cb-empty-state-art`)
- Test: `packages/design/test/display.test.tsx` (EmptyState cases)

**Interfaces:**
- Consumes: `useBrand()`, `brandArtStyle()` (Task 2.1).

- [ ] **Step 1: Failing tests:** `page and panel draw the theme art as a masked box with
  --cb-brand-art` (`data-part="empty-illustration"` holds a `data-part="empty-brand-art"` element
  with the style, no `svg`); `illustrationUrl wins over markUrl`; `compact draws no art`; `without a
  brand, or with both URLs null, the DOM equals today's` (LogoLine svg); `the art stays aria-hidden`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (CSS: fixed boxes, `mask-image:
  var(--cb-brand-art)`, `background: var(--cb-faint)`). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(design): empty state draws the theme's art (#451)`.

### Task 2.3: `Greeting` and `WorkingLine` marks

**Files:**
- Modify: `packages/design/src/conversation/greeting.tsx` (mark :71-82)
- Modify: `packages/design/src/conversation/working-line.tsx` (:15-21 frames)
- Modify: `packages/design/src/styles/conversation.css` (`.cb-greeting-mark`, working-line mark and
  the pulse keyframes under `prefers-reduced-motion: no-preference`)
- Test: `packages/design/test/new-conversation.test.tsx` (Greeting), `packages/design/test/working-line.test.tsx`

- [ ] **Step 1: Failing tests:** `Greeting draws the theme mark 20 px high instead of the bitmap`;
  `a failing mark falls back to the bitmap`; `WorkingLine draws the theme mark with the pulse
  attribute (data-motion="pulse") and no leg frames`; `reduced motion or still: no pulse`;
  `captions rotate as before`; `without a brand both DOMs equal today's`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(design): greeting and working line draw the theme's mark (#451)`.

### Task 2.4: `AuthPage` decoration

**Files:**
- Modify: `packages/design/src/templates/auth-page.tsx` (:51, :102)
- Modify: `packages/design/src/styles/templates.css` only if the card's centring depends on the
  columns (the card width must not change)
- Test: `packages/design/test/templates.test.tsx`

- [ ] **Step 1: Failing tests:** `decoration none draws no dither columns; the card and its width
  are unchanged`; `PreferenceBar keeps its corner without the columns`; `default draws both columns`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; run
  `packages/design/test/box-in-box.test.tsx` (`findNestedBoxes` unchanged).
- [ ] **Step 5: Commit** `feat(design): a theme can turn the sign-in decoration off (#451)`.

### Task 2.5: Web `ThemeRef` and `ThemeRoot` brand

**Files:**
- Modify: `apps/web/src/lib/themes.ts` (`ThemeRef` :10-27: the Task 1.4 fields)
- Modify: `apps/web/src/components/theme-root.tsx` (`Themed` :64-78)
- Test: `apps/web/test/theme-root.test.tsx`, fixtures in `apps/web/test/support/` that build a
  `ThemeRef`

**Interfaces:**
- Consumes: `Brand` (Task 2.1), kernel `ThemeRef` (Task 1.4).
- Produces: `brandOf(theme: ThemeRef | null, productName: string | null): Brand | null` (exported
  from `theme-root.tsx`; null when the theme sets nothing and there is no product name), reused by
  `StaticTheme` in Task 4.2.

- [ ] **Step 1: Failing tests:** `the brand carries illustrationUrl and decoration`; `the built-in
  theme gives a null brand` (until #452: `productName` null); `decoration none reaches AuthPage`
  (render the auth layout's client tree with a fixture theme, assert no `.cb-dither`).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/theme-root.test.tsx` → FAIL.
- [ ] **Step 3: Implement**; with #452 merged, `productName` comes from `useProductName()`.
- [ ] **Step 4: Run** → PASS; `pnpm check:web-ui`.
- [ ] **Step 5: Commit** `feat(web): ThemeRoot passes the theme's illustration and decoration (#451)`.

### Task 2.7: Catalog, reference blocks, acceptance, visual cases

**Files:**
- Create: `packages/design/src/fixtures/brand.ts` (export `FIXTURE_BRAND`: data-URI SVG mark and
  illustration, `decoration: "none"`, wordmark `BRAND KIT`), exported from `src/fixtures/index.ts`
- Modify: `apps/web/src/dev/catalog/routes.tsx` (route `brand/fixture`), a new
  `apps/web/src/dev/catalog/brand-blocks.tsx` (EmptyState page and panel, Greeting still,
  WorkingLine still, AuthPage without decoration, StatusPage 404, all under `BrandRoot` with
  `FIXTURE_BRAND`), `apps/web/src/dev/catalog/reference-blocks.tsx` (RefBlocks with the new state
  ids)
- Modify: `docs/design/reference/src/empty-state.html` (or the file holding the empty-state
  blocks), `greeting.html`, `working-line` blocks, the auth template blocks: one block per new state
- Modify: `apps/web/visual/accepted.ts` (new states), `apps/web/visual/catalog.spec.ts` only if the
  route needs a `prepare` step
- Create: `.changeset/theme-brand-graphics.md` (`@capybara-hq/design`, `@capybara-hq/capybara`: patch)

- [ ] **Step 1:** Add fixtures, catalog route and RefBlocks; `pnpm check:web-ui`.
- [ ] **Step 2:** Run `COMPARE=empty-state,greeting,working-line pnpm --filter @capybara-hq/web compare`
  in the Linux Playwright image; the controller dispatches the blind image reviewer (writing-web-ui
  step 4); fix severe and moderate differences.
- [ ] **Step 3:** `pnpm verify`; push; trigger `reference-update` then `visual-update` with the PR
  branch. Acceptance: the workflow adds only `brand-fixture-*` shots; **any change to an existing
  baseline is a bug** (goal 5), fixed before merge.
- [ ] **Step 4: Commit** `test(web): brand fixture catalog cases (#451)`; open the PR with the diff
  images attached.

---

## PR 3: Avatars (kernel + design + web + `Platform`)

Depends on PR 1; independent of PR 2. Changesets: `@capybara-hq/kernel`, `@capybara-hq/design`,
`@capybara-hq/capybara` (patch).

### Task 3.1: Kernel avatar schema and the org's theme presets

**Files:**
- Modify: `packages/kernel/src/agents/profile.ts` (`PRESET_IDS` :5 → SDK export; `randomPreset` :27
  removed in favour of Task 3.2's service method; `AgentAvatarSchema` :31 gains the stored `theme`
  kind; `PresetAvatarSchema` :53 id widens)
- Modify: `packages/kernel/src/themes/themes.service.ts` (`OrgThemes` :19, new methods)
- Modify: `packages/kernel/src/themes/theme-state.ts` (helper for preset URLs, beside `themeUrl`)
- Modify: `packages/kernel/src/platform/ops/themes.ops.ts` (description names `avatars`)
- Create: `tools/checks/test/avatar-presets.test.ts`
- Test: `packages/kernel/test/themes/resolve.test.ts`, `packages/kernel/test/agents/profile.test.ts`

**Interfaces:**
- Produces:
  - `THEME_PRESET_KEY_RE`: `<CATALOG_ITEM_NAME_RE body>/<theme id body>/<THEME_AVATAR_ID_RE body>`
    (plugin name as `CATALOG_ITEM_NAME_RE`, theme id as the SDK's theme id rule)
  - `PresetAvatarSchema = { kind: "preset", id: BuiltinAvatarPresetId | string matching THEME_PRESET_KEY_RE }`
  - stored `{ kind: "theme"; themeId: string; version: string; preset: string; file: string }` in
    `AgentAvatarSchema` (never accepted from a client)
  - `ThemesService.orgDefault(orgId): Promise<ThemeDefinition & { id: string } | null>`: the org
    default if on in the org, else the platform default if on in the org (same predicates as
    `forOrg`, never the viewer's pick)
  - `ThemesService.avatarPresets(orgId): Promise<OrgAvatars>` with
    `OrgAvatars = { hidden: BuiltinAvatarPresetId[]; presets: { key: string; name: LocalizedName; url: string; themeId: string; version: string; preset: string; file: string }[] }`
  - `OrgThemes.avatars: { hidden: string[]; presets: { key; name; url }[] }` (the public subset)

- [ ] **Step 1: Failing tests:** `resolve.test.ts`: `avatars come from the org default, not the
  viewer's pick`; `the platform default applies when the org follows it`; `a default theme that is
  off in the org gives no presets and hides nothing`; `keys are plugin/theme/preset and urls are
  delivery URLs`. `profile.test.ts`: `a preset id outside the built-ins and the key pattern is 400`.
  `tools/checks/test/avatar-presets.test.ts`: `the design AVATAR_PRESET_IDS equal the SDK's
  BUILTIN_AVATAR_PRESET_IDS in order` (plus a red case comparing a reordered copy).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS;
  `pnpm exec vitest run tools/checks/test/platform-parity.test.ts` (the widened field stays in
  parity: the operation reuses `PresetAvatarSchema`).
- [ ] **Step 5: Commit** `feat(kernel): theme avatar presets of the org's default theme (#451)`.

### Task 3.3: Design `AvatarPicker` hidden and extra presets

**Files:**
- Modify: `packages/design/src/display/avatar.tsx` (`AvatarPickerProps` :123, `AvatarPicker` :141-200)
- Modify: `packages/design/src/styles/display.css` only for the image tile (reuse the upload
  tile's image rule if it fits)
- Modify: `docs/design/spec.md` §6.30 (hidden and theme presets, tile naming)
- Test: `packages/design/test/avatar.test.tsx`

**Interfaces:**
- Produces:
  - `AvatarPickerProps` gains `hidden?: readonly PresetId[]` and
    `extra?: readonly { key: string; name: string; src: string }[]`
  - `type AvatarChoice = AvatarValue | { kind: "theme"; key: string; src: string }`; `value` and
    `onChange` use it (a theme tile is checked when `value.kind === "theme" && value.key === key`)
  - `visibleAvatarChoices(hidden, extra): AvatarChoice[]` (the order the picker shows: remaining
    built-ins, then theme presets), exported for the web's random default

- [ ] **Step 1: Failing tests:** `hidden built-ins are not listed`; `theme presets follow the
  remaining built-ins, before the upload tile`; `a theme tile is named by its localized name and
  selects { kind: "theme", key }`; `a stored hidden preset still renders as Avatar` (Avatar itself is
  unchanged); `without hidden and extra the DOM equals today's`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(design): avatar picker with hidden and theme presets (#451)`.

### Task 3.2: Kernel avatar write path, random default, views (high)

**Files:**
- Modify: `packages/kernel/src/agents/agent-profile.service.ts` (:38-131: resolve a theme key before
  the write)
- Modify: `packages/kernel/src/agents/agents.service.ts` (:84-90 create check, :647-648 default)
- Modify: `packages/kernel/src/agents/from-template.service.ts` (:39, :180 pass through)
- Modify: `packages/kernel/src/agents/agents.controller.ts` (`GET :agentId/avatar` :223-245: 302 to
  the pinned URL for `theme`)
- Modify: `packages/kernel/src/agents/agent-lookup.ts` (:233), `admin-agents.ts` (:313),
  `packages/kernel/src/conversations/conversations.service.ts` (:1156): views carry `url` for `theme`
- Modify: `packages/kernel/src/errors.ts` (`agent.avatar_unavailable`: 400, beside :323)
- Modify: `packages/kernel/src/platform/ops/agents.ops.ts` (:90-120: description says theme keys
  come from `themes.list` `avatars`; `errors` entry for `agent.avatar_unavailable` with its `next`)
- Test: `packages/kernel/test/agents/profile.test.ts`, `packages/kernel/test/agents/avatar.test.ts`,
  `packages/kernel/test/agents/admin-agents.test.ts`, `packages/kernel/test/platform/ops-workspace.test.ts`
  (or the ops test that covers `agents.update-profile`)

**Interfaces:**
- Consumes: `ThemesService.avatarPresets` (Task 3.1).
- Produces:
  - `AgentProfileService.resolveAvatarInput(orgId, input): Promise<StoredAvatar>`: built-in id →
    `{ kind: "preset", id }` (always accepted, also while hidden); theme key in
    `avatarPresets(orgId)` → pinned `theme` value; else `ApiError("agent.avatar_unavailable", …)`
  - `AgentsService.randomAvatar(orgId): Promise<AgentAvatar | null>`: uniform over the visible
    built-ins plus the theme presets; none visible → null; `node:crypto` `randomInt` as today
  - `avatarView(stored: AgentAvatar): AgentAvatar & { url?: string }` (adds `url` for `theme`)

- [ ] **Step 1: Failing tests:**
  - `a theme key of the org's effective default is stored pinned and returned with its url`
  - `a theme key of a theme that is not the org's default is 400 agent.avatar_unavailable`
  - `a theme key of another org's org-owned theme is 400` (cross-tenant: org B's own theme, key
    guessed from org A)
  - `a built-in id is accepted while the theme hides it`
  - `a pinned avatar is still served after the theme updates to a new version and after it leaves
    the org` (the URL keeps answering 200; the view still has `url`)
  - `random default never picks a hidden preset` (hide nine, one theme preset: 50 creates, every
    avatar is the visible built-in or the theme preset; assert the set, not a distribution)
  - `random default is null when nothing is visible`
  - `create from a template keeps the template's built-in avatar while hidden`
  - `GET agents/:id/avatar redirects to the pinned URL for a theme avatar`
  - `the admin listing and the conversation list carry url for a theme avatar`
  - `Platform agents.update-profile with a theme key: stored pinned; with an unavailable key: the
    error's next step`
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/agents packages/kernel/test/platform` → FAIL.
- [ ] **Step 3: Implement** (reads only; the write stays in the existing `@Transactional()` method,
  the preset lookup happens before it, no lock).
- [ ] **Step 4: Run** → PASS; `pnpm check:platform-ops`, `pnpm check:kernel-conventions`,
  `pnpm exec vitest run tools/checks/test/platform-parity.test.ts`.
- [ ] **Step 5: Commit** `feat(kernel): theme avatars stored pinned; random default follows the theme (#451)`.

### Task 3.4: Web avatar choices

**Files:**
- Modify: `apps/web/src/lib/themes.ts` (`OrgThemes` :41: `avatars`)
- Modify: `apps/web/src/lib/agents.ts` (`AgentAvatar` :269 adds `theme` with `url`; `avatarValue`
  :578 maps it to `{ kind: "image", src: url }`; `ProfileInput` avatar id type widens)
- Modify: `apps/web/src/lib/admin-items.ts` (`adminAvatarValue` :182: `theme` → image)
- Create: `apps/web/src/lib/avatar-choices.ts`: `useAvatarChoices(orgId)` from `orgThemesQuery`
  → `{ hidden, extra, randomChoice(random?) }`, and the mapping between `AvatarChoice` and the
  kernel input (`{ kind: "theme", key }` → `{ kind: "preset", id: key }`)
- Modify: `apps/web/src/components/AgentForm.tsx` (:48-50 and :110, :208, :256: random over the
  visible choices, picker props)
- Modify: `apps/web/src/components/agent/CreateFromTemplateDialog.tsx` (:58-59, :106, :222)
- Modify: `apps/web/src/components/agent/BasicsSection.tsx` (:267, :380: picker props; a stored
  `theme` avatar shows as the checked theme tile while still offered, else as an image)
- Test: `apps/web/test/agent-form.test.tsx`, `apps/web/test/agent-from-template.test.tsx`,
  `apps/web/test/agent-page-sections.test.tsx`, `apps/web/test/admin-agents.test.tsx`,
  `apps/web/test/agent-profile-lib.test.ts`

- [ ] **Step 1: Failing tests:** `the create form never preselects a hidden preset`; `the picker
  lists the theme presets and saves the key`; `from-template uses the same choices`; `the basics
  section shows a stored theme avatar as the checked tile`; `the admin console draws a theme avatar
  as an image`; `avatarValue maps theme to its url`; `a 400 agent.avatar_unavailable shows its
  message` (`useErrorMessage`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm check:web-ui`.
- [ ] **Step 5: Commit** `feat(web): avatar picker follows the org's default theme (#451)`.

### Task 3.5: Specs, catalog, visual, changesets

**Files:**
- Modify: `docs/superpowers/specs/2026-11-04-agent-profile-and-new-chat-design.md` (presets:
  hidden, theme presets, pinned storage, random default)
- Modify: `apps/web/src/dev/catalog/reference-blocks.tsx` (:1294-1370: picker with `hidden` and
  `extra` from `FIXTURE_BRAND`-like data-URI presets), `docs/design/reference/src/avatar.html` (state
  `theme-presets`), `apps/web/visual/accepted.ts`
- Create: `.changeset/theme-avatars.md` (`@capybara-hq/kernel`, `@capybara-hq/design`,
  `@capybara-hq/capybara`: patch)

- [ ] **Step 1:** Edit; `pnpm check:web-ui`, `pnpm check:agent-docs`.
- [ ] **Step 2:** `pnpm verify`; push; `reference-update`, then `visual-update` on the branch; only the
  new picker state may add shots, no existing baseline changes.
- [ ] **Step 3: Commit** `docs: theme avatar presets in the agent profile spec (#451)`; open the PR.

---

## PR 4: Pages outside the theme (web)

Depends on PR 1, PR 2 and #452. Changesets: `@capybara-hq/design` (theme-color hook),
`@capybara-hq/capybara` (patch).

### Task 4.1: Brand cookie codec and `outsideTheme()` (high)

**Files:**
- Create: `apps/web/src/lib/brand-cookie.ts`
- Create: `apps/web/src/lib/server/outside-theme.ts`
- Create: `apps/web/test/brand-cookie.test.ts`, `apps/web/test/outside-theme.test.ts` (node project)

**Interfaces:**
- Produces:
  - `BRAND_COOKIE = "cb-brand"`, `BRAND_COOKIE_MAX_AGE = 2_592_000`
  - `interface BrandRef { cssUrl: string; markUrl: string | null; wordmark: string | null; illustrationUrl: string | null; faviconUrl: string | null; decoration: "dither" | "none"; background: { dark?: string; light?: string } }`
  - `encodeBrandCookie(ref: BrandRef): string | null` (null when over 1 KB)
  - `decodeBrandCookie(raw: string | undefined): BrandRef | null` (any invalid field → null)
  - `brandRefOf(theme: ThemeRef): BrandRef`
  - `brandCookieHeader(ref: BrandRef | null, secure: boolean): string` (the `document.cookie`
    string, deletion when null)
  - `outsideTheme(): Promise<BrandRef | null>` (server): the cookie when valid; else
    `platformThemeQuery()` through the request's query client when the kernel answers; else null
  - `outsideThemeFromCookie(): BrandRef | null` (client, through `useSyncExternalStore`, server
    snapshot null)

- [ ] **Step 1: Failing tests** (`brand-cookie.test.ts`): `round trip of a full ref`; red cases,
  each discarding the whole cookie: `an external URL`, `a protocol-relative URL`, `javascript:`,
  `a query string`, `..` and `%2e%2e` segments, `a quote in a path`, `a CSS URL without r<int>`,
  `a wordmark with a forbidden character`, `a colour outside the grammar` (`red`, `#fff`),
  `decoration "stars"`, `wrong version`, `not base64url`, `oversized (> 1 KB)`; `the header has
  Path=/, SameSite=Lax, max-age, Secure only when asked`. `outside-theme.test.ts`: `cookie wins
  over the platform default`; `the platform default when no cookie`; `null when the kernel throws`;
  `an invalid cookie falls through to the platform default`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/brand-cookie.test.ts apps/web/test/outside-theme.test.ts` → FAIL.
- [ ] **Step 3: Implement** (the rules restate the SDK's wordmark and colour grammar: `apps/web`
  imports no SDK; comment names the SDK source).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): brand cookie codec and the outside-theme rule (#451)`.

### Task 4.2: `StaticTheme`, cookie write, theme-color sync

**Files:**
- Modify: `apps/web/src/components/theme-root.tsx` (`Themed` writes the cookie after each commit
  whose drawn theme changes; renews on every themed document; deletes under the built-in theme;
  shares `ThemeLink`, `BrandRoot`, `brandOf`)
- Create: `apps/web/src/components/static-theme.tsx`
- Create: `packages/design/src/shell/theme-color.ts` (exported from `packages/design/src/index.ts`)
- Test: `apps/web/test/theme-root.test.tsx`, `apps/web/test/static-theme.test.tsx`,
  `packages/design/test/theme-color.test.tsx`

**Interfaces:**
- Consumes: `BrandRef`, `brandCookieHeader`, `brandRefOf` (Task 4.1), `brandOf` (Task 2.5).
- Produces:
  - `StaticTheme({ brand: BrandRef | null, children })`: links `brand.cssUrl` (`ThemeLink`
    semantics) and provides the brand through `BrandRoot`; no query
  - design `useThemeColorMeta(): void`: after mount, on `data-theme` changes of `<html>`
    (MutationObserver) and when the theme stylesheet loads, sets `<meta name="theme-color">`
    `content` to the computed `--cb-bg`; no-op without the meta

- [ ] **Step 1: Failing tests:** `ThemeRoot writes cb-brand for a theme and deletes it for the
  built-in theme`; `the cookie is rewritten only when the drawn theme changes`; `StaticTheme links
  the CSS and draws the mark`; `StaticTheme with null renders the built-in brand`;
  `useThemeColorMeta updates the meta after a scheme toggle` (jsdom: set `--cb-bg` per
  `data-theme` with an inline style sheet in the test).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm check:web-ui`.
- [ ] **Step 5: Commit** `feat(web): StaticTheme, brand cookie write and theme-color sync (#451)`.

### Task 4.4: Root layout metadata, app icons, manifest colours

**Files:**
- Modify: `apps/web/src/app/layout.tsx` (`viewport` :41-50 → `generateViewport`; `generateMetadata`
  :57-72: favicon parent from the cookie, `platformIconsMetadata(meta, platformTheme)`)
- Modify: `apps/web/src/lib/web-manifest.ts` (`webManifest(meta, platformTheme)`,
  `platformIconsMetadata(meta, platformTheme)`, colours from `background`)
- Modify: `apps/web/src/app/manifest.ts` (reads the platform theme beside the meta)
- Test: `apps/web/test/manifest.test.ts`, `apps/web/test/icon.test.ts`, `apps/web/test/root-viewport.test.ts` (new, node)

**Interfaces:**
- Produces: `rootViewport(scheme: "dark" | "light", ref: BrandRef | null): Viewport` (one
  `themeColor` for the rendered scheme: the ref's `background[scheme]`, else the single defined
  scheme's, else `PAGE_BACKGROUND[scheme]`), used by the root and route-group `generateViewport`.

- [ ] **Step 1: Failing tests:** `manifest icons: upload > theme appIcon > built-in` (each of the
  three, for `any` and `maskable`; a theme with `appIcon` only lists `any` from the theme and the
  built-in maskable only when nothing else); `apple-touch: upload > theme > built-in`; `favicon order
  unchanged`; `manifest colours: background.dark, else light, else PAGE_BACKGROUND.dark`;
  `rootViewport writes one colour for the cookie's scheme`; `a single-scheme theme uses its scheme's
  colour`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (colours only from `PAGE_BACKGROUND` or the
  kernel's values: no literal). **Step 4: Run** → PASS; `pnpm check:web-ui`.
- [ ] **Step 5: Commit** `feat(web): app icons and browser colours follow the platform theme (#451)`.

### Task 4.3: Kernel-starting frame, root error pages, root 404, layout icons

**Files:**
- Modify: `apps/web/src/app/(app)/layout.tsx` (:57 `KernelStarting` inside `StaticTheme` with the
  cookie ref)
- Modify: `apps/web/src/app/error.tsx` (inside `StaticTheme`, client cookie)
- Modify: `apps/web/src/app/global-error.tsx` (`StaticTheme` from the client cookie, next to its
  locale and scheme)
- Create: `apps/web/src/app/not-found.tsx` (server: `outsideTheme()`, `StaticTheme`, a client
  `StatusPage` 404 body with the home link as `(app)/not-found.tsx`)
- Modify: `apps/web/src/lib/server/theme.ts` (`themeIcons` :12: the route-group layouts always set
  `icon` explicitly: theme favicon, else upload, else built-in; `workspaceViewport` /
  `platformViewport` for the `(app)` and `(auth)` `generateViewport`)
- Modify: `apps/web/src/app/(auth)/layout.tsx` (export `generateViewport`)
- Test: `apps/web/test/app-layout.test.tsx`, `apps/web/test/auth-layout.test.tsx`,
  `apps/web/test/pages.test.tsx` (error pages), `apps/web/test/root-not-found.test.tsx` (new)

- [ ] **Step 1: Failing tests:** `KernelStarting renders under the cookie's theme when the shell is
  unavailable` and `under the built-in theme without a cookie`; `the root error page links the
  cookie's CSS`; `global-error links the cookie's CSS`; `the root 404 uses the cookie, else the
  platform default, else built-in, and links home`; `a route-group layout always sets icon` (a stale
  cookie favicon never survives); `(app) generateViewport uses the resolved theme's background`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm check:web-ui`.
- [ ] **Step 5: Commit** `feat(web): pages outside the theme render under the brand cookie (#451)`.

### Task 4.5: `AppIconSection` preview and message

**Files:**
- Modify: `apps/web/src/components/AppIconSection.tsx` (preview the effective default: the platform
  theme's icon, labelled "来自主题 {name}" / "From theme {name}", when no upload)
- Modify: `apps/web/messages/zh.json`, `apps/web/messages/en.json` (`appIcon.fromTheme`)
- Test: `apps/web/test/app-icon-section.test.tsx`

- [ ] **Step 1: Failing tests:** `without an upload, a theme app icon is previewed and labelled with
  the theme name`; `an upload wins and restore-default returns to the theme's`; `without either, the
  built-in PNGs as today`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm check:i18n`.
- [ ] **Step 5: Commit** `feat(web): app icon settings show the theme's icon as the default (#451)`.

### Task 4.6: E2E and visual

**Files:**
- Modify: `apps/web/e2e/themes.spec.ts` (`brand-kit` as platform default)
- Modify: `apps/web/src/dev/catalog/brand-blocks.tsx` only if a root-404 case is missing from PR 2

- [ ] **Step 1: Cases:** `the root 404 links the theme CSS and draws the mark` (a path no layout
  serves); `KernelStarting renders the cookie's theme` (cookie set by a themed page, then the fake
  kernel answer stopped through the e2e support; where the harness cannot stop it, the component
  test of Task 4.3 stands and the case is skipped with that reason); `the manifest lists the theme's
  app icons`; `empty states show the theme art and no capybara` (a workspace list page); `sign-in
  without dither under brand-kit`; each case restores the platform default.
- [ ] **Step 2: Run** `pnpm --filter @capybara-hq/web e2e themes.spec.ts` → PASS.
- [ ] **Step 3: Commit** `test(web): e2e for pages outside the theme (#451)`.

### Task 4.7: Docs and PR

**Files:**
- Modify: `docs/superpowers/specs/2026-11-08-themes-design.md` (§7: `outsideTheme()` instead of
  "the built-in theme" for the root pages; §8: the brand cookie; §16 M2 closed)
- Modify: `docs/superpowers/specs/2026-11-19-mobile-layout-design.md` (§10.2 icon and colour
  precedence)
- Modify: `.agents/skills/writing-web-ui/SKILL.md` (pages outside the theme, the brand cookie,
  `StaticTheme`), `.agents/skills/writing-extension-ui/SKILL.md` (:312 "the root error pages load
  none" stays; add that they draw the cookie's theme)
- Create: `.changeset/pages-outside-theme.md` (`@capybara-hq/design`, `@capybara-hq/capybara`: patch)

- [ ] **Step 1:** Edit; `pnpm check:agent-docs`, `pnpm lint`.
- [ ] **Step 2:** `pnpm verify`; push; `visual-update` only if Task 4.6 changed catalog cases; no
  built-in baseline change.
- [ ] **Step 3: Commit** `docs: pages outside the theme in the themes and mobile specs (#451)`; open
  the PR.

---

## PR 5: Plugins repository follow-up (`capybara-hq/plugins`)

### Task 5.1: SDK bump, `theme-cyberpunk` brand fields, authoring skills, release

**Files (plugins repo):**
- Modify: root `package.json` `pnpm.overrides` (`@capybara-hq/plugin-sdk` pinned to the new rc so
  every plugin resolves one SDK instance; see memory note on `instanceof ToolError`) and each
  plugin's `@capybara-hq/plugin-sdk` range
- Modify: `plugins/theme-cyberpunk/themes/*.json` (optional `logo.appIcon` /
  `logo.appIconMaskable`, `hideAvatarPresets: ["capybara"]` with one theme avatar), the assets
- Modify: the plugins repo's `writing-plugins` / `writing-extension-ui` skills (theme fields)
- Create: a changeset for `theme-cyberpunk`

- [ ] **Step 1:** Bump and override; `pnpm install`; `pnpm verify` (connector e2e included).
- [ ] **Step 2:** Add the theme fields; `capybara-plugin check plugins/theme-cyberpunk` → clean.
- [ ] **Step 3:** Commit `chore: plugin-sdk with theme brand fields; cyberpunk app icon (#451)`;
  open the PR; release through the repo's version PR; update the marketplace entry.

---

## Spec coverage (self-review)

| Spec | Task |
|---|---|
| §1 theme file fields and rules | 1.1, 1.2, 1.3 |
| §2 `ThemeRef`, delivery | 1.4, 2.5 |
| §3 Brand, EmptyState, Greeting, WorkingLine, Logo fallback and alt, AuthPage, CSS URLs | 2.1-2.5 |
| §4 avatars (read, write, pinned, random, existing agents, Platform) | 3.1-3.4 |
| §5 brand cookie, `outsideTheme()`, `StaticTheme`, the four pages, favicon parent | 4.1-4.3, 4.4 |
| §6 app icons, `AppIconSection`, manifest colours, `themeColor` | 4.4, 4.5, 4.2 |
| §7 caching, CSP, multi-replica | constraints; 1.4 tests the cache headers |
| §8 i18n, mobile, accessibility | 3.3, 4.5, 2.2, 2.3 |
| §9 #452 | coordination section, 2.1, 2.5 |
| §10 changesets, docs | per PR |
| Testing, visual | per task; 2.7, 3.5, 4.6 |

## Open questions

1. **#452 sets the platform name as the fallback wordmark** (its uncommitted
   `theme-root.tsx`: `wordmark = theme?.logo?.wordmark ?? product`), which contradicts accepted
   decision 7 (the built-in wordmark `CAPYBARA` stays beside the pixel capybara). Recommendation:
   #452 drops that line and passes the name only as `Brand.productName` (Logo's `alt`), as Task 2.1
   defines; tell the #452 line before it opens its PR.
2. **Visual cases "under the fixture theme"**: the visual harness has no kernel, so it cannot load a
   theme stylesheet. Recommendation: the catalog's `brand/fixture` route draws the fixture brand
   (data-URI marks) under the built-in tokens, and the fixture theme's tokens stay covered by the
   e2e computed-style checks in `themes.spec.ts`; themes spec §16 M2 is closed on that basis.
