# Client Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. With more than five tasks, plan the waves with the `wave-planned-subagent-development` skill (AGENTS.md). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plugin's extension can ship client code (one browser ES module, CSS, assets) that renders React components in slots, replaces built-in blocks in replaceable slots and decorates the web through stable part and state hooks, an overlay and client events. Safe mode, a kill switch, error boundaries and a crash budget always give back the official UI. One action applies a plugin's suggested appearance.

**Architecture:** The SDK owns the catalog additions (`component` kind, `cardinality: "single"` slots, `UI_PARTS`), the `client` section and `suggestedAppearance` of `plugin.json`, and the new permission inputs. The new `@capybara-hq/plugin-client` package holds the types and hooks plugins build against; in the browser its specifier resolves through an import map to the web host's implementation. `capybara-plugin pack` builds the bundle with esbuild and records sha384 integrity. The kernel reviews the new sensitive keys, extracts each package's client files into object storage keyed by package sha256 (`extension_client_builds`), serves them on access-checked immutable routes, lists the org's client extensions for the shell read, resolves single-slot winners from the arrangement, stores crash reports and applies suggested appearances. The web adds a nonce CSP, CSS layers, `ClientHost` (import map, `modulepreload`, `import()`, registry, crash budget, navigation boundary), component rendering in `ExtensionSlot`, the four new slots, `data-cap-part` / `data-cap-state`, client events and the admin and org pages.

**Tech Stack:** TypeScript, zod (SDK, kernel DTOs), esbuild (pack), NestJS + Fastify + Kysely (kernel), Next 16 / React 19 + TanStack Query (web), vitest, Playwright, acorn-based source checks (`tools/checks`).

**Spec:** `docs/superpowers/specs/2026-11-09-client-extensions-design.md` (read it with this plan; § numbers below are the spec's; C1-C9 and D1-D4 are recorded there). It builds on the UI slots plan (`2026-11-09-ui-slots.md`), which must be merged first.

## Global Constraints

- Run single tests from the repo root: `pnpm exec vitest run <path>` (never `pnpm --filter <pkg> exec vitest`). Finish each task with `pnpm typecheck` and `pnpm lint`, and `pnpm check` when the task touches a checked area (kernel conventions, web UI, i18n, platform ops, SDK API, package schemas, bootstrap, extension permissions).
- Kernel code follows `check:kernel-conventions`: `@Injectable` providers in one module each, explicit `@Inject` on every constructor parameter, DTOs via `createZodDto` with `@ZBody` / `@ZQuery` / `@ZParam`, config through `KernelConfigService`, writes in `@Transactional()` methods, enqueues / bus / Redis / object-store deletes in `afterCommit`. The periodic job is `@LockedCron` under `WorkerModule`.
- Migration: one file, `packages/kernel/src/migrations/0104_extension_client_builds.sql` (renumber to the next free number if main moved), `IF [NOT] EXISTS`, kernel schema, both tables of spec §9.1 and §10.4. Applied files are never edited.
- Exact values (spec): `CLIENT_API_VERSION = 1`; `CLIENT_LIMITS = { entryBytes: 1048576, styleFiles: 8, styleBytes: 262144, assetFiles: 64, assetBytes: 2097152, totalBytes: 8388608, loadTimeoutMs: 10000, pendingMs: 1500, crashBudget: 3 }`; `UI_LIMITS.componentDataBytes = 32768`; asset types `.png .webp .svg .woff2 .mp3 .ogg .wav`; report `message` ≤ 500 characters, throttle 20 / minute / account, retention 30 days; `suggestedAppearance.replacements` ≤ 8 entries.
- New slot ids: `shell.brand`, `conversation.empty`, `conversation.composer.frame` (single, replaceable, accepts `component` only, scope `org`, minRole `guest`) and `shell.overlay` (list, `maxShown: 4`, accepts `component`, scope `org`, minRole `guest`). Owners: `components/shell/AppFrame.tsx` (brand, overlay), `components/conversation/NewConversation.tsx` (empty), `components/conversation/ComposerBar.tsx` (composer frame).
- Permission keys: `permissions.client` and `ui.component:<id>`, both sensitive (reasons `client_code`, `ui_component`) and blocking; only `ui.view:*` stays non-blocking.
- Routes, exactly: `GET /api/v1/client/:plugin/:build/*file`; `GET /api/v1/orgs/:orgId/ui/client`; `GET /api/v1/admin/ui/client?plugin=`; `POST /api/v1/orgs/:orgId/ui/client/reports`; `POST /api/v1/admin/ui/client/reports`; `POST /api/v1/admin/catalog/items/:id/appearance`; `POST /api/v1/orgs/:orgId/extensions/:extension/appearance`. Storage prefix `platform/client/<plugin>/<sha256>/` under `storage.deployment()`.
- Error codes: `client.not_found` 404, `client.undeclared` 400, `client.integrity_mismatch` 400, `client.invalid` 400; each with en and zh copy under `errors.*` in `apps/web/messages/{en,zh}.json`, added by the task that registers the code.
- Client event names, exactly: `run.started`, `run.finished`, `run.failed`, `message.sent`, `message.received`, `tool.started`, `tool.finished`, `approval.requested` (payloads spec §7.5). State tokens `run=`, `motion=`, `theme=` on `[data-cap-part~="shell"]`.
- `apps/web` writes no styles and imports no SDK and no `@capybara-hq/plugin-client` (it reads generated copies: `lib/ui-slots.generated.ts`, `lib/client-host/api.generated.ts`). Every read is a `defineQuery`, every write `useAppMutation`, pages are thin `page.tsx` + client `view.tsx`, never a box inside a box.
- zh UI copy says 平台 / 超级管理员 / 智能体, never 企业 or the Latin word `agent` (`check:i18n`). New strings: 客户端代码, 插件界面代码, 停用界面代码, 界面代码, 安全模式, 以安全模式重新加载, 应用此插件的外观, 内置.
- SDK public API changes: `pnpm gen:sdk-api` plus a changeset bumping `@capybara-hq/plugin-sdk`. `plugin-client` (new, first release `0.1.0-rc.x` in the current pre mode), `plugin-tools`, `kernel`, `testing`, `design` and the web image (`@capybara-hq/capybara`) get changesets.
- Never `place` in new fixtures or code: only `slot` (UI slots step A still accepts it as input).
- Before 0.1.0: no compatibility layers (one `CLIENT_API_VERSION`).

## Review Focus

1. **A crashing client bundle taking down the conversation page.** A component that throws on render, a module that throws at evaluation, an `events` listener that throws and a module that never resolves must each leave the conversation streaming and the composer usable. The crash budget disables the plugin at the third error and its components fall back. Tests in Tasks 18 and 21 (`fake-client-broken`).
2. **Safe mode not actually loading zero plugin code.** With `?safe-ui=1` the first document must contain no import map, no `modulepreload` of `/api/v1/client/`, no `precedence="extensions"` stylesheet, and the browser must make no request under `/api/v1/client/` for the whole document lifetime, client navigations included. Tests in Tasks 17 and 21.
3. **An org's client code reaching another org or the admin console.** Delivery must 404 for a member of an org where the plugin is off, for an unconfirmed org upload and an unapproved snapshot; the org shell read never lists another org's plugins; `/admin/*` pages other than `/admin/p/<plugin>/<id>` load no client code and no plugin CSS, and a client navigation from the workspace into `/admin` is a document load. Tests in Tasks 10, 17 and 21.
4. **A replacement failing to fall back.** A winner that throws, times out (10 s), fails integrity, has an unsupported `apiVersion`, binds another slot, or drops the composer's `children` must render the built-in, reported once. An unavailable `use` key must resolve to the built-in, never to the other level's choice. Tests in Tasks 9 and 18.
5. **CSS layering making plugin CSS lose or win where it must not.** A plugin rule on `[data-cap-part~="button.primary"]` must beat the design rule for the same property, the theme's token values must beat the design defaults, and the design and theme layers must still apply when no plugin CSS exists. `!important` in the design layer beats a plugin's normal rule (layer semantics), and no plugin stylesheet is linked on admin pages. Tests in Tasks 14 and 21.

---

### Task 1: SDK catalog: `component` kind, single slots, the four new slots

Risk: medium (the catalog every layer reads).

**Files:**
- Modify: `packages/plugin-sdk/src/ui.ts` (`UiKind` gains `"component"`), `packages/plugin-sdk/src/ui-slots.ts` (`UiSlotSpec.cardinality`, `replaceable?`, `builtin?`, the four rows, `accepts` of the seven component slots, `UI_SINGLE_SLOTS`, `UI_ARRANGEABLE_SLOTS` unchanged in meaning), `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/api/plugin-sdk.api.md`
- Regenerate: `apps/web/src/lib/ui-slots.generated.ts`, `docs/guide/ui-slots.md` (`pnpm gen:ui-slots`)
- Test: `packages/plugin-sdk/test/ui-slots.test.ts`

**Interfaces:**
- Produces:
  - `type UiKind = "view" | "embed" | "component"`
  - `UiSlotSpec { …; accepts: readonly UiKind[]; cardinality: "list" | "single"; replaceable?: true; builtin?: { en: string; zh: string } }`
  - `UI_SLOT_IDS` appends `shell.brand`, `shell.overlay`, `conversation.empty`, `conversation.composer.frame` (catalog order).
  - `accepts` gains `"component"` on `conversation.panel`, `conversation.properties.section`, `conversation.tool-result.card`, `org.page`, `agent.detail.section`, `org.settings.section`, `platform.page`; `file.preview` stays `["embed"]`.
  - `UI_SINGLE_SLOTS: readonly UiSlotId[]` (the three single slots); `UI_COMPONENT_SLOTS: readonly UiSlotId[]`.

- [ ] **Step 1: Write the failing tests** in `ui-slots.test.ts`:
  - `"single slots are replaceable, name their builtin and accept only component"`: for every `cardinality === "single"` row, `replaceable === true`, `builtin.en` and `builtin.zh` non-empty, `accepts` deep-equals `["component"]`, no `anchors`, no `limits`.
  - `"list slots carry no replaceable or builtin"`.
  - `"the four new slots have the spec's owners and scope"`: table assertion on owner, scope `org`, minRole `guest`, `shell.overlay` `limits.maxShown === 4`.
  - `"file.preview does not accept component"`; `"the seven L1 slots accept component"`.
  - `"zh descriptions avoid 企业 and the word agent"` over the new rows.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/ui-slots.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; run `pnpm gen:ui-slots`.
- [ ] **Step 4: Run** the test, `pnpm check:ui-slots` (it must now report `ui-slot-unrendered` for the four new slots: add them to the checker's temporary allowlist `PENDING_SLOTS` in `tools/checks/src/ui-slots.ts`, removed in Task 18), `pnpm gen:sdk-api && pnpm check:sdk-api`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset (plugin-sdk minor): `feat(plugin-sdk): component kind and replaceable slots in the UI catalog`.

### Task 2: SDK component contributions, `permissions.client`, component view data

Risk: high (structural validation decides what fails an extension's load).

**Files:**
- Modify: `packages/plugin-sdk/src/permissions.ts` (`ExtensionPermissions.client?: boolean`, `ui.components?: string[]`, `validateUiContributions`), `packages/plugin-sdk/src/ui.ts` (`UiView.data?: JsonValue`, `UI_LIMITS.componentDataBytes`, `validateUiView(view, { component: boolean })`), `packages/plugin-sdk/src/ui-resolve.ts` (no change in rules; components resolve like views), `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/api/plugin-sdk.api.md`
- Test: `packages/plugin-sdk/test/ui.test.ts`, `packages/plugin-sdk/test/define-extension.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `validateUiContributions` new messages: `ui "<id>" is a component; list it in permissions.ui.components`; `permissions.ui.components lists "<id>", which is not a component contribution`; `ui "<id>" is listed in more than one of permissions.ui.views / embeds / components`; `ui "<id>" is a component and cannot have a path`; `permissions.ui.components needs permissions.client: true`.
  - `validateUiView(view: unknown, opts?: { component?: boolean }): string[]`: `data` refused unless `opts.component` (`view data is only allowed for component views`), and over 32 768 JSON bytes refused (`view data is <n> bytes; the limit is 32768`); a component view may have `blocks: []`.

- [ ] **Step 1: Write the failing tests:**
  - `ui.test.ts` `"a component must be listed in permissions.ui.components"` and the reverse case, each one error with the message above.
  - `"an id in both views and components is refused"`.
  - `"a component with a path is refused"`.
  - `"components need permissions.client"`: `ui.components: ["a"]` without `client: true` → error.
  - `"a component in file.preview is a structural error"`: message `slot file.preview does not accept kind component`.
  - `"a component in an unknown slot is not structural"` → `[]`.
  - `"view data is refused for views and accepted for components"`; `"view data over 32768 bytes is refused"` (a 32 769-byte string payload).
  - `define-extension.test.ts` `"defineExtension accepts components with client: true and keeps ui as written"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/ui.test.ts packages/plugin-sdk/test/define-extension.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm exec vitest run packages/plugin-sdk`, `pnpm gen:sdk-api && pnpm check:sdk-api`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset: `feat(plugin-sdk): component contributions and the client permission`.

### Task 3: SDK `client` section and `suggestedAppearance` in `plugin.json`

Risk: medium.

**Files:**
- Create: `packages/plugin-sdk/src/client-section.ts`
- Modify: `packages/plugin-sdk/src/plugin-manifest.ts` (`PluginExtensionSection.client?`, top-level `suggestedAppearance?`, cross-checks in `parsePluginManifest`), `packages/plugin-sdk/schemas/plugin.v1.schema.json` (`pnpm gen:package-schemas`), `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/api/plugin-sdk.api.md`
- Test: `packages/plugin-sdk/test/client-section.test.ts`, `packages/plugin-sdk/test/plugin-manifest.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces:
  - `interface PluginClientSection { entry?: string; styles?: string[]; assets?: string[]; integrity: Record<string, string>; apiVersion: number }` (paths `./dist/client/client.mjs`, `./dist/client/styles/<name>.css`, `./dist/client/assets/<path>`)
  - `CLIENT_LIMITS` (Global Constraints); `CLIENT_ASSET_TYPES: Readonly<Record<string, string>>` (extension → content type); `CLIENT_API_VERSION = 1` (also exported here so the kernel need not import plugin-client)
  - `validateClientSection(s: unknown): string[]`: entry or ≥ 1 style; paths under `./dist/client/`; every listed file has an `integrity` entry matching `^sha384-[A-Za-z0-9+/]{64}$` and no extra entries; ≤ 8 styles; ≤ 64 assets with allowed extensions; `apiVersion` a positive integer.
  - `interface SuggestedAppearance { theme?: string; replacements?: Record<string, string> }`
  - `parsePluginManifest` issues: `client` without `extension.manifest.permissions.client === true` → `extension.client needs permissions.client: true` and the reverse; `suggestedAppearance` empty → `suggestedAppearance needs theme or replacements`; `theme` not among the plugin's theme ids (when `themes` is listed; with the scan default the kernel / packer re-check after the scan, see Tasks 6 and 8); `replacements` without an extension; > 8 entries; a key failing `parseSlotRef`; for a known slot that is not single, `suggestedAppearance.replacements: <slot> is not a replaceable slot`; a value that is not a `component` contribution of the manifest in that slot → `suggestedAppearance.replacements: <slot> names <id>, which is not a component contribution in that slot`. An unknown slot is accepted.
  - `appearanceIssues(manifest: PluginManifest, themeIds: readonly string[]): string[]` (the theme check after a scan, shared by pack and the kernel).

- [ ] **Step 1: Write the failing tests:**
  - `client-section.test.ts` `"a section needs an entry or a style"`, `"every file needs a sha384 integrity and nothing else is listed"`, `"assets of an unknown type are refused"`, `"paths outside dist/client are refused"`, `"nine styles are refused"`.
  - `plugin-manifest.test.ts` `"client needs permissions.client and the reverse"`, `"suggestedAppearance needs theme or replacements"`, `"a replacement in a list slot is refused"`, `"a replacement naming a view is refused"`, `"a replacement in an unknown slot is accepted"`, `"appearanceIssues refuses a theme the plugin does not carry"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/client-section.test.ts packages/plugin-sdk/test/plugin-manifest.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `pnpm gen:package-schemas`.
- [ ] **Step 4: Run** the tests, `pnpm check:package-schemas`, `pnpm gen:sdk-api && pnpm check:sdk-api`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset: `feat(plugin-sdk): client section and suggested appearance in plugin.json`.

### Task 4: SDK `UI_PARTS` catalog and `check:ui-parts` (catalog and generated copies)

Risk: low.

**Files:**
- Create: `packages/plugin-sdk/src/ui-parts.ts`, `tools/checks/src/ui-parts.ts`, `tools/checks/src/cli/ui-parts.ts`, `tools/checks/src/cli/gen-ui-parts.ts`
- Generated (committed): `packages/design/src/ui-parts.generated.ts`, `packages/plugin-client/src/ui-parts.generated.ts` (the package exists from Task 5), `docs/guide/ui-parts.md`
- Modify: `packages/plugin-sdk/src/index.ts`, `package.json` (scripts `gen:ui-parts`, `check:ui-parts`), `tools/checks/src/cli/all.ts`, `tools/checks/README.md` (entry: full on PRs, cheap)
- Create fixtures: `tools/checks/fixtures/ui-parts/stale/`
- Test: `packages/plugin-sdk/test/ui-parts.test.ts`, `tools/checks/test/ui-parts.test.ts`

**Interfaces:**
- Produces:
  - `interface UiPartSpec { name: UiPartName; version: number; owner: string; states: readonly ("aria-current" | "aria-selected" | "aria-expanded" | "aria-busy" | "disabled")[]; description: { en: string; zh: string } }`
  - `UI_PARTS` with the 20 rows of spec §7.1 (`owner` relative to the repo root, `packages/design/src/…` or `apps/web/src/…`); `UiPartName`; `uiPart(name)`.
  - `checkUiParts(root, parts = UI_PARTS): Finding[]` with, in this task, only `ui-parts-stale` (the render rules arrive in Task 15).

- [ ] **Step 1: Write the failing tests**: `"part names are unique and dotted lower-case"`, `"owners are under packages/design/src or apps/web/src"`, `"zh descriptions avoid 企业"`; checks `"a stale generated copy reports ui-parts-stale"`, `"the repo root is clean"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/ui-parts.test.ts tools/checks/test/ui-parts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `pnpm gen:ui-parts`.
- [ ] **Step 4: Run** the tests, `pnpm check:ui-parts`, `pnpm gen:sdk-api && pnpm check:sdk-api`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset: `feat(plugin-sdk): UI parts catalog`.

### Task 5: The `@capybara-hq/plugin-client` package

Risk: medium (the public plugin API; versioned).

**Files:**
- Create: `packages/plugin-client/{package.json,tsconfig.json,README.md,CHANGELOG.md}`, `packages/plugin-client/src/{index.ts,types.ts,define.ts,hooks.ts,context.ts,design.ts,events.ts,slots.generated.ts,ui-parts.generated.ts}`, `packages/plugin-client/src/testing/index.ts` (export `./testing`), `packages/plugin-client/api/plugin-client.api.md`
- Create: `tools/checks/src/plugin-client-api.ts`, `tools/checks/src/cli/plugin-client-api.ts`, `tools/checks/src/cli/gen-plugin-client.ts`; generated `apps/web/src/lib/client-host/api.generated.ts`
- Modify: `tools/checks/src/cli/gen-ui-slots.ts` (second output into the package; the parts copy arrives with Task 4), `tools/checks/src/cli/all.ts`, `tools/checks/README.md`, root `package.json` (scripts `gen:plugin-client`, `check:plugin-client-api`), `tsconfig.json` references, `pnpm-workspace.yaml` if needed, `docs/architecture.md` (the package and its edges: depends on no `@capybara-hq/*`; plugins depend on it; the web implements it without importing it), `.changeset/` (new package)
- Test: `packages/plugin-client/test/define.test.ts`, `packages/plugin-client/test/hooks.test.tsx`, `tools/checks/test/plugin-client-api.test.ts`

**Interfaces:**
- Produces: exactly the exports of spec §4.2: `CLIENT_API_VERSION`, `ComponentSlotId`, `BaseComponentProps`, `SlotComponentProps`, `ComponentProps`, `ClientComponent`, `defineComponent`, `ClientExtensionDefinition`, `ClientExtension`, `defineClientExtension`, `ClientApi`, `ClientStorage`, `RunState`, `CapybaraEventType`, `CapybaraEvent`, `CapybaraEventOf`, the hooks `useView`, `useAction`, `useAccess`, `useLocale`, `useRunState`, `useCapybaraEvents`, `usePrefersReducedMotion`, `useTheme`, `useClientStorage`, `useAssetUrl`, `PluginClientContextError`, and the design names `Button`, `Badge`, `Icon`, `KeyValue`, `Kbd`, `Logo`, `Spinner`, `Stack`, `Text`, `Tooltip`, `PropertySection`, `ViewBlocks`.
  - Runtime: hooks read `HostContext` (a React context whose value the host provides per component: `{ plugin, contribution, slot, args, api: HostApi }`); outside it they throw `PluginClientContextError`. Design names forward to `globalThis.__CAPYBARA_CLIENT_HOST__.design.<Name>` at render time (in tests, the fake host's).
  - `@capybara-hq/plugin-client/testing`: `renderWithFakeHost(element, { slot, args?, role?, locale?, runState?, view?, onAction?, events? }): { emit(e: CapybaraEvent): void; setRunState(s: RunState): void; rerender(): void; unmount(): void }`.
  - `apps/web/src/lib/client-host/api.generated.ts`: `CLIENT_API_VERSION`, `PLUGIN_CLIENT_EXPORTS: readonly string[]` (sorted), `DESIGN_SUBSET: readonly string[]`, `COMPONENT_SLOT_IDS`.
  - `check:plugin-client-api` (full on PRs, cheap): rule `plugin-client-api-stale` when the generated web copy differs from the package's export list.

- [ ] **Step 1: Write the failing tests:**
  - `define.test.ts` `"defineClientExtension stamps the api version"`, `"defineComponent keeps the slot"`.
  - `hooks.test.tsx` `"hooks throw PluginClientContextError outside the host"`; `"useRunState follows the fake host"` (setRunState("running") re-renders with `running`); `"useCapybaraEvents filters by type"` (emit `run.started` and `tool.finished`, handler with `types: ["run.started"]` sees one); `"useClientStorage prefixes keys with cap-ext:<plugin>:"`; `"useLocale.t picks the locale"`.
  - `plugin-client-api.test.ts` `"a stale web copy reports plugin-client-api-stale"`, `"the repo root is clean"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-client tools/checks/test/plugin-client-api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `pnpm gen:plugin-client && pnpm gen:ui-slots`. Until Task 4, `ui-parts.generated.ts` in the package is a placeholder exporting an empty list, replaced by the generator there.
- [ ] **Step 4: Run** the tests, `pnpm check:plugin-client-api`, `pnpm check:deps` (the package imports no `@capybara-hq/*`), `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset creating `@capybara-hq/plugin-client`: `feat(plugin-client): the client extension package`.

### Task 6: `capybara-plugin pack` builds client code; `check` rules

Risk: medium (what gets shipped; integrity starts here).

**Files:**
- Create: `packages/plugin-tools/src/pack/client.ts`, `packages/plugin-tools/src/check/client.ts`
- Modify: `packages/plugin-tools/src/pack/pack.ts` (call `buildClient` after the server bundle; write `extension.client`; enforce `permissions.client`), `packages/plugin-tools/src/check/plugin-pack.ts` (append `clientFindings`, `appearanceFindings`), `tools/checks/src/bootstrap.ts` (rule `bootstrap-client-code`), `tools/checks/README.md`
- Create fixtures: `packages/plugin-tools/test/fixtures/plugin-client-clean/` (a component, one CSS file on parts, one `.ogg` asset), `plugin-client-forbidden-import/` (imports `lodash-es` unresolved and `node:fs`), `plugin-client-remote-css/` (`@import url(https://…)`), `plugin-client-big/` (entry over 1 MiB), `plugin-client-undeclared/` (client code without `permissions.client`), `plugin-client-selector/` (`.cb-sidebar a { … }`), `plugin-appearance-bad/` (replacement in `conversation.panel`); `tools/checks/fixtures/bootstrap/client-code/`
- Test: `packages/plugin-tools/test/pack-client.test.ts`, `packages/plugin-tools/test/check-client.test.ts`, `tools/checks/test/bootstrap.test.ts`

**Interfaces:**
- Consumes: Tasks 2-3, Task 5 (externals list, `CLIENT_API_VERSION`).
- Produces:
  - `buildClient(dir: string, stage: string): Promise<PluginClientSection | null>`: esbuild `{ platform: "browser", format: "esm", target: "es2022", bundle: true, minify: true, jsx: "automatic", external: ["react", "react-dom", "react/jsx-runtime", "@capybara-hq/plugin-client"], metafile: true }` from `src/client.tsx` or `src/client.ts`; CSS from `client/styles/*.css` (sorted) wrapped in `@layer extensions {\n…\n}`; assets from `client/assets/**`; sha384 of every written file; `apiVersion` = `CLIENT_API_VERSION`.
  - Findings: `client-import-forbidden`, `client-css-remote`, `client-size`, `client-api-version`, `client-undeclared` (errors); `client-css-selector`, `ui-part-unknown` (warnings, a `data-cap-part` / `[data-cap-part~=…]` value not in `UI_PARTS`); `appearance-invalid` (error, from `parsePluginManifest` and `appearanceIssues`).

- [ ] **Step 1: Write the failing tests:**
  - `pack-client.test.ts` `"pack writes the client section with sha384 integrity"`: packing `plugin-client-clean` yields `extension.client.entry === "./dist/client/client.mjs"`, one style, one asset, and each integrity equals `sha384-` + base64 of the file in the tgz.
  - `"the bundle keeps the four externals as bare imports"`: the output contains `from"react"` and `from"@capybara-hq/plugin-client"` and no copy of React (no `react.production`).
  - `"CSS is wrapped in @layer extensions"`.
  - `"pack fails without permissions.client"` (`plugin-client-undeclared`), message names `client-undeclared`.
  - `check-client.test.ts`: each red fixture yields exactly its rule; `plugin-client-selector` yields only the warning (passes `errorsOf`); `plugin-client-clean` yields `[]`.
  - `bootstrap.test.ts` `"a bootstrap plugin with client code is refused"` (`bootstrap-client-code`).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-tools/test/pack-client.test.ts packages/plugin-tools/test/check-client.test.ts tools/checks/test/bootstrap.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm exec vitest run packages/plugin-tools`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset on `@capybara-hq/plugin-tools`: `feat(plugin-tools): pack and check client code`.

### Task 7: Kernel permission review of `client` and `ui.component`

Risk: high (the trust decision of D2).

**Files:**
- Modify: `packages/kernel/src/extensions/permission-set.ts` (`buildPermissionSet`: `permissions.client`, `ui.components`; `permissionKeys`: `permissions.client`, `ui.component:<id>`), `packages/kernel/src/extensions/permission-view.ts` (category `client`, `ALWAYS_SENSITIVE` gains it, reasons `client_code` / `ui_component`, `keyItem` table rows, `permissionGroups` lists `component:<id>` in `ui` and a `client` group), `packages/kernel/src/extensions/cli.ts` (review output), `apps/web/src/components/…` where the permission groups render (the 客户端代码 group label only; i18n `extensionPermissions.groups.client`), `apps/web/messages/{en,zh}.json`
- Test: `packages/kernel/test/extensions/permission-client.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces: `PermissionSet.permissions.client: boolean`, `PermissionSet.permissions.ui.components: string[]`; `SensitiveReason` gains `"client_code" | "ui_component"`; `blockingKeys` unchanged (still exempts only `ui.view:`).

- [ ] **Step 1: Write the failing tests:**
  - `"permissionKeys lists permissions.client and ui.component keys"`.
  - `"both keys are sensitive"`: `isSensitivePermissionKey("permissions.client")` and `isSensitivePermissionKey("ui.component:hud")` are true; `"ui.view:hud"` stays false.
  - `"an upgrade adding a component blocks loading"`: `blockingKeys(diffPermissions(old, new).added)` contains `ui.component:hud`.
  - `"a bundle-only upgrade adds no key"`: two sets differing only by a package sha produce no added keys.
  - `"an old snapshot without client fields parses as no client"` (tolerant `permissionKeys`).
  - `"capybara extensions review marks client keys (sensitive)"`: CLI output contains `permissions.client  (sensitive)`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/extensions/permission-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test, `pnpm exec vitest run packages/kernel/test/extensions`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset on `@capybara-hq/kernel`: `feat(kernel): review client code and components as sensitive permissions`.

### Task 8: Kernel import checks and client build storage (migration 0104)

Risk: high (what is stored and later trusted by integrity).

**Files:**
- Create: `packages/kernel/src/migrations/0104_extension_client_builds.sql`, `packages/kernel/src/client/client.module.ts`, `packages/kernel/src/client/client-builds.service.ts`, `packages/kernel/src/client/client-css.ts` (the wrap / `@import` / absolute `url()` check)
- Modify: `packages/kernel/src/extensions/blobs.ts` (`ExtensionBlobs.store` calls `ClientBuilds.extract` for a package with `section.client`, before `record` commits; refuses with `storage.unavailable` when no object store), `packages/kernel/src/catalog/plugin-import.ts` (the import review re-runs `validateClientSection`, `appearanceIssues` after the theme scan, the manifest / section agreement), `packages/kernel/src/errors.ts` (codes), `packages/kernel/src/db/schema.ts` (Kysely types), `packages/kernel/src/kernel.module.ts` (`ClientModule`), `apps/web/messages/{en,zh}.json` (`errors.client.*`), package cleanup (where the package row is deleted, delete the prefix in `afterCommit`)
- Test: `packages/kernel/test/client/client-builds.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6, 7.
- Produces:
  - Tables (spec §9.1, §10.4): `extension_client_builds` and `extension_client_reports (plugin text NOT NULL, build text NOT NULL, org_id uuid NULL, contribution text NULL, kind text NOT NULL CHECK (kind IN ('load','render','event','api','budget')), count int NOT NULL DEFAULT 1, first_at timestamptz NOT NULL DEFAULT now(), last_at timestamptz NOT NULL DEFAULT now(), last_message text NOT NULL)` with a unique index on `(plugin, build, coalesce(org_id::text, ''), coalesce(contribution, ''), kind)` and an index on `last_at`.
  - `ClientBuilds.extract(sha256: string, plugin: string, files: ReadonlyMap<string, Uint8Array>, section: PluginClientSection): Promise<void>` (idempotent by sha256: writes objects then inserts the row with `ON CONFLICT DO NOTHING`); `ClientBuilds.byPackage(sha256): Promise<ClientBuildRow | null>`.
  - Errors: `client.undeclared` 400, `client.integrity_mismatch` 400 (details `{ file }`), `client.invalid` 400 (details `{ file, reason }`).

- [ ] **Step 1: Write the failing tests** (testing containers: PG + SeaweedFS via `startTestS3`):
  - `"a package with client code stores its files and one build row"`: objects exist under `deployment/platform/client/fake-client/<sha256>/client.mjs` etc.; row `integrity` equals the section's.
  - `"storing the same package twice writes one row"`.
  - `"a tampered file refuses the import with client.integrity_mismatch"` (flip a byte in the tgz's `client.mjs`, recompute nothing).
  - `"a client section without permissions.client refuses with client.undeclared"`.
  - `"an unwrapped stylesheet or one with @import refuses with client.invalid"`.
  - `"no object store refuses with storage.unavailable"`.
  - `"suggestedAppearance naming a theme the plugin lacks refuses the import"` (`plugin.invalid` with the `appearanceIssues` message).
  - `"deleting the package row deletes the client prefix after commit"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/client/client-builds.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; `pnpm exec capybara migrate` against the dev database.
- [ ] **Step 4: Run** the test, `pnpm exec vitest run packages/kernel/test/catalog packages/kernel/test/extensions packages/kernel/test/migrations`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset: `feat(kernel): store client builds per package`.

### Task 9: Kernel UI routes for components; `use` for single slots

Risk: high (access gates and winner resolution).

**Files:**
- Modify: `packages/kernel/src/ui/views.ts` (components listed with `kind: "component"`; single slots list at most the winner; `resolve` accepts component ids; `validateUiView(view, { component })`), `packages/kernel/src/ui/registry.ts`, `packages/kernel/src/ui/arrangement.ts` (`use` resolution, listing), `packages/kernel/src/identity/settings.ts` (`UiArrangementSchema`: per slot `{ hidden, order } | { use: string | null }`, refusals), `packages/kernel/src/ui/ui.schemas.ts` (item `kind` enum), `packages/kernel/src/ctx/create-ctx.ts` (`ctx.ui.view` / `action` accept ids in `permissions.ui.components`), `packages/kernel/src/tools/pipeline.ts` (`inlineViews` includes component cards), `tools/checks/src/plugin-permissions.ts` (`perm-ui` accepts component ids)
- Create fixture: `packages/kernel/test/fixtures/plugins/ui-components/` (components `hud` in `conversation.properties.section` with a `ctx.ui.view("hud")` returning `{ blocks: [], data: { n: 1 } }`, `brand` in `shell.brand`, `empty` in `conversation.empty`, `frame` in `conversation.composer.frame`, `fx` in `shell.overlay`, `card` in `conversation.tool-result.card` returned by tool `ping`; `permissions.client: true`; a minimal `src/client.tsx`. In this task it loads as a directory fixture, which carries no package section; Task 10 installs it through `packFixture`, so Task 8's section check applies from there on)
- Test: `packages/kernel/test/ui/components.http.test.ts`, `packages/kernel/test/ui/arrangement-use.http.test.ts`, `tools/checks/test/plugin-permissions.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 7 (Task 8 runs a wave later and must keep these tests green).
- Produces:
  - `UiContributionItem.kind: "view" | "embed" | "component"`.
  - Arrangement entry type `UiArrangementEntry = { hidden: string[]; order: string[] } | { use: string | null }`; `resolveSingleSlot(slot, orgEntry, platformEntry, available: Set<string>): string | null` (pure, in `arrangement.ts`).
  - `GET …/ui/arrangement` items for single slots: `{ slot, candidates: { key, title }[], use: string | null, followsPlatform: boolean }`.

- [ ] **Step 1: Write the failing tests:**
  - `components.http.test.ts` `"components are listed with kind component"`; `"a component view returns data"` (`GET views/ui-components/hud?conversationId=` → `view.data` `{ n: 1 }`); `"a view returning data is invalid"` (another fixture view returning `data` → 502 `ui.invalid_view`); `"a guest gets a conversation component view; a reader of another conversation gets 404"`; `"single slots list nothing until a winner is chosen"`; `"the pipeline keeps a card naming a component"`.
  - `arrangement-use.http.test.ts` `"the org use picks the winner"`; `"the platform use is the default and the org entry replaces it"`; `"use null is the built-in even when the platform picked one"`; `"an unavailable use key resolves to the built-in, not the platform's choice"` (org `use` names an extension switched off in the org; platform picked an available one → list empty); `"use on a list slot and hidden on a single slot are 400"`; `"resolveSingleSlot table"` (pure, eight rows).
  - `plugin-permissions.test.ts` `"ctx.ui.view on a component id passes perm-ui"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/ui/components.http.test.ts packages/kernel/test/ui/arrangement-use.http.test.ts tools/checks/test/plugin-permissions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm exec vitest run packages/kernel/test/ui`, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset: `feat(kernel): component contributions and replaceable slot winners`.

### Task 10: Kernel delivery, shell routes and the kill switch

Risk: high (access to client files).

**Files:**
- Create: `packages/kernel/src/client/client-delivery.controller.ts` (`api/v1/client`), `packages/kernel/src/client/client.controller.ts` (org `api/v1/orgs/:orgId/ui/client`, admin `api/v1/admin/ui/client`), `packages/kernel/src/client/client-access.service.ts`, `packages/kernel/src/client/client.schemas.ts`
- Modify: `packages/kernel/src/identity/settings.ts` (`clientExtensions: { enabled: boolean; disabled: string[] }` in `DEPLOYMENT_SETTINGS` and the patch, default `{ enabled: true, disabled: [] }`), `packages/kernel/src/platform/exclusions.ts` (delivery `transport`, shell reads `internal`), `packages/kernel/src/platform/ops/admin.ops.ts` (`admin.update-settings` gains the field), `packages/kernel/src/errors.ts` (`client.not_found`), `packages/kernel/src/client/client.module.ts`, `apps/web/messages/{en,zh}.json`
- Test: `packages/kernel/test/client/delivery.http.test.ts`, `packages/kernel/test/client/shell.http.test.ts`

**Interfaces:**
- Consumes: Tasks 8-9, Task 13 (`packFixture` builds client entries; the `ui-components` fixture is now installed packed).
- Produces:
  - `ClientAccess.canFetch(accountId: string, superAdmin: boolean, plugin: string, build: string): Promise<boolean>` (one query: the build is `extension_installs.sha256` of a running extension, and the account is a super admin with a `platform.page` component in that build's manifest, or a member of a live org where the extension is enabled; the kill switch and `disabled` refuse).
  - `ClientExtensionsResponse` (spec §9.2); the admin route takes `?plugin=` and returns at most that plugin, with `styles: []`.

- [ ] **Step 1: Write the failing tests** (fixtures `ui-components`, orgs A (on) and B (off), an org upload awaiting confirmation, an extension with an unapproved snapshot):
  - `delivery.http.test.ts` `"a member of an org where the plugin is on gets the bundle"`: 200, `content-type: text/javascript`, `cache-control: private, max-age=31536000, immutable`, `x-content-type-options: nosniff`, `cross-origin-resource-policy: same-origin`, body bytes' sha384 equals the row's integrity.
  - `"a guest of that org gets it too"`.
  - `"a member of an org where the plugin is off gets 404 client.not_found"`; `"an awaiting org upload is 404"`; `"an unapproved snapshot is 404"`; `"an old build is 404 after the upgrade"`; `"an unknown file is 404"`; `"a path with .. is 404"`; `"signed out is 401"`.
  - `"a super admin who is no member gets only builds with a platform.page component"`.
  - `"the kill switch and disabled refuse delivery"`.
  - `"an svg asset carries the sandbox CSP"`.
  - `shell.http.test.ts` `"the org read lists enabled running plugins with urls and integrity"`; `"components are filtered by the viewer's role"` (a member does not see `org.settings.section` components); `"another org's plugins are never listed"`; `"enabled false under the kill switch with no items"`; `"the admin read lists only platform.page components and no styles"`; `"a non super admin gets forbidden on the admin read"`; both `no-store`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/client/delivery.http.test.ts packages/kernel/test/client/shell.http.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check` (`check:platform-ops`, `check:kernel-conventions`). Expected: PASS.
- [ ] **Step 5: Commit** with a changeset: `feat(kernel): deliver client code to the orgs where it is on`.

### Task 11: Kernel reports, prune job, admin detail

Risk: medium.

**Files:**
- Create: `packages/kernel/src/client/client-reports.service.ts`, `packages/kernel/src/client/client-reports.cron.ts`
- Modify: `packages/kernel/src/client/client.controller.ts` (the two report routes), `packages/kernel/src/client/client.schemas.ts`, `packages/kernel/src/infra/throttler/named-throttlers.ts` (`clientReports`: 20 / 60 s / account), `packages/kernel/src/worker/…` (provide the cron under `WorkerModule`), `packages/kernel/src/extensions/admin-view.ts` and `permission-view.ts` (`AdminExtensionView.client`, `clientReports`), `packages/kernel/src/platform/exclusions.ts` (report routes `transport`)
- Test: `packages/kernel/test/client/reports.http.test.ts`, `packages/kernel/test/client/reports-prune.test.ts`

**Interfaces:**
- Produces: `ReportBody = { plugin: string; build: string /* 64 hex */; contribution: string | null; kind: "load" | "render" | "event" | "api" | "budget"; message: string /* ≤ 500 */ }` → 204; `AdminExtensionView.client: { build: string; files: { path: string; bytes: number }[]; apiVersion: number } | null`, `clientReports: { orgId: string | null; contribution: string | null; kind: string; count: number; firstAt: string; lastAt: string; lastMessage: string }[]` (current build, newest first, ≤ 50).

- [ ] **Step 1: Write the failing tests:**
  - `"a report upserts one row and counts"` (two posts → `count: 2`, `last_message` the second).
  - `"a report for a plugin not on in the org is 404"`; `"a message over 500 characters is 400"`.
  - `"the 21st report in a minute is 429"`.
  - `"the admin detail lists the build and its reports"`.
  - `reports-prune.test.ts` `"rows older than 30 days are deleted once per tick across two replicas"` (dual-replica harness; one delete statement observed).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/client/reports.http.test.ts packages/kernel/test/client/reports-prune.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset: `feat(kernel): client crash reports`.

### Task 12: Kernel suggested appearance and its Platform operations

Risk: medium (writes two settings levels in one step).

**Files:**
- Create: `packages/kernel/src/catalog/appearance.service.ts`, `packages/kernel/src/catalog/appearance.schemas.ts`
- Modify: `packages/kernel/src/catalog/admin-catalog.controller.ts` (`POST items/:id/appearance`), `packages/kernel/src/catalog/org-extension.controller.ts` (`POST :extension/appearance`), the item detail and org extension list (`suggestedAppearance`), `packages/kernel/src/platform/ops/catalog-admin.ops.ts` (`catalog-admin.apply-appearance`), `packages/kernel/src/platform/ops/org-plugins.ops.ts` (`org-plugins.apply-appearance`), `packages/kernel/src/platform/exclusions.ts`, `packages/kernel/src/catalog/catalog.module.ts`
- Test: `packages/kernel/test/catalog/appearance.http.test.ts`, `packages/kernel/test/platform/appearance-ops.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 9 (arrangement `use`), the themes service (platform default and org default writers, lock order catalog item → theme row → `uiTheme` row).
- Produces: `AppearanceService.apply(level: { platform: true } | { orgId: string }, item: string, actor, dryRun: boolean): Promise<AppearanceResult>` with `AppearanceResult = { theme: { from: string | null; to: string } | null; replacements: { slot: string; from: string | null; to: string }[]; skipped: { what: string; reason: "unknown-slot" | "not-available" | "not-eligible" }[] }`.

- [ ] **Step 1: Write the failing tests:**
  - `"a dry run lists the changes and writes nothing"` (settings unchanged after).
  - `"the super admin applies theme and replacements in one step"` (platform `uiTheme.id` = the plugin's theme row id; platform arrangement `use` set for both slots).
  - `"an org admin applies them at org level and keeps personal"` (`orgs.settings.theme = { id, personal: "locked" }` keeps `locked`).
  - `"a theme that cannot be the platform default refuses the whole call"` (`theme.not_available`; arrangement unchanged).
  - `"an unavailable replacement is skipped, not refused"`; `"an unknown slot is skipped"`.
  - `"a member gets 404 and no action"`; `"a plugin without suggestedAppearance is 404"`.
  - `appearance-ops.test.ts` `"both operations are confirmed and never rememberable"`; `"the dry run is the preview"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/appearance.http.test.ts packages/kernel/test/platform/appearance-ops.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check` (`check:platform-ops`). Expected: PASS.
- [ ] **Step 5: Commit** with a changeset: `feat(kernel): apply a plugin's suggested appearance`.

### Task 13: Testing fixtures `fake-client` and `fake-client-broken`

Risk: low.

**Files:**
- Create: `packages/testing/fixtures/extensions/fake-client/` (`src/index.ts`: components `hud` (`conversation.properties.section`, view with `data`), `brand` (`shell.brand`, renders `builtin` inside a `<span data-testid="fake-client-brand">`), `empty` (`conversation.empty`), `frame` (`conversation.composer.frame`, renders `children`), `fx` (`shell.overlay`); `src/client.tsx` using `@capybara-hq/plugin-client`; `client/styles/fake.css` setting `outline-color` on `[data-cap-part~="button.primary"]` and `--cx-fake-client-run: 1` under `[data-cap-state~="run=running"]`; an `events` listener writing the last event type to `useClientStorage`; a `themes/fake.json`; `suggestedAppearance` naming the theme and `shell.brand`), `packages/testing/fixtures/extensions/fake-client-broken/` (component `boom` throws on render; module-level `events` listener throws on `run.started`; a `conversation.empty` replacement that throws)
- Modify: `packages/testing/src/fixtures.ts` (`packFixture` runs `buildClient`), `packages/testing/package.json` (devDependency `@capybara-hq/plugin-client` workspace), `tools/ci/test-plugins.json` unchanged (fixtures are not plugins)
- Test: `packages/testing/test/fake-client.test.ts`

- [ ] **Step 1: Write the failing tests**: `"packFixture builds fake-client with a client section"`; `"fake-client-broken packs"`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/testing/test/fake-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset on `@capybara-hq/testing`: `test(testing): client extension fixtures`.

### Task 14: CSS layers in design and the theme stylesheet

Risk: high (layering decides who wins everywhere).

**Files:**
- Modify: `packages/design/src/styles/index.css` (first line `@layer design, theme, extensions;`, every `@import "./x.css" layer(design);`), `packages/kernel/src/themes/render-css.ts` (wrap the output in `@layer theme {…}`), `apps/web/next.config.mjs` only if Turbopack needs it for `layer()` imports
- Test: `packages/kernel/test/themes/render-css.test.ts`, `apps/web/test/css-layers.test.ts`, `apps/web/e2e/css-layers.spec.ts`

- [ ] **Step 1: Write the failing tests:**
  - `render-css.test.ts` `"theme css is one @layer theme block"`.
  - `css-layers.test.ts` `"the design stylesheet declares the layer order first"`: the built CSS (read from `packages/design/src/styles/index.css`) starts with `@layer design, theme, extensions;` and every import has `layer(design)`.
  - `css-layers.spec.ts` (Playwright, test page `/dev/ui`): `"a theme token beats the design default"` (fake theme sets `accent`; computed `--cb-accent` equals it); `"an extensions-layer rule beats the design rule"` (inject `<style>@layer extensions{[data-cap-part~="button"]{outline-color:rgb(1,2,3)}}</style>`, computed `outline-color` is `rgb(1, 2, 3)`); `"design !important beats a plugin rule"` (a design rule with `!important` kept); `"no plugin css: the design and theme still apply"` (visual reference unchanged: the existing visual and fidelity suites pass).
- [ ] **Step 2: Run** the three. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm --filter @capybara-hq/web build`, `pnpm exec playwright test -c apps/web/playwright.visual.config.ts` locally to see that nothing moved (baselines are rendered only by `visual-update`; a diff here is a bug). Expected: PASS.
- [ ] **Step 5: Commit** with changesets (design, kernel): `feat(design): cascade layers for design, theme and extensions`.

### Task 15: Design primitives, `data-cap-part` and the `check:ui-parts` render rules

Risk: medium.

**Files:**
- Create: `packages/design/src/shell/decoration-layer.tsx`, `packages/design/src/shell/replaceable-frame.tsx`, `packages/design/src/shell/safe-mode-banner.tsx`, styles in `packages/design/src/styles/shell.css`
- Modify: `docs/design/tokens.json` (layering `decoration` above every other layer) and `pnpm gen:tokens`; `packages/design/src/shell/sidebar.tsx` (`brand?: ReactNode`; `data-cap-part` on `sidebar`, `sidebar.brand`, `sidebar.item`), and every owner file of the 20 parts (spec §7.1, the builder fixes the exact file and updates `UI_PARTS.owner`); `packages/design/src/index.ts`; `tools/checks/src/ui-parts.ts` (render rules); `/dev/ui` pages for the three primitives
- Create fixtures: `tools/checks/fixtures/ui-parts/{unrendered,undeclared,owner,dynamic}/`
- Test: `packages/design/test/decoration-layer.test.tsx`, `packages/design/test/replaceable-frame.test.tsx`, `packages/design/test/ui-parts.test.tsx`, `tools/checks/test/ui-parts.test.ts`

**Interfaces:**
- Produces: `DecorationLayer({ children })` (`aria-hidden`, `pointer-events: none` except `[data-cap-interactive]`), `ReplaceableFrame({ pending: boolean; children })` (`visibility: hidden` while pending, layout kept), `SafeModeBanner({ onExit(): void })`, `Sidebar` prop `brand?: ReactNode`, `AppShell` prop `capState?: string` (rendered as `data-cap-state`).
- `check:ui-parts` rules `ui-part-unrendered`, `ui-part-undeclared`, `ui-part-owner`, `ui-part-literal`.

- [ ] **Step 1: Write the failing tests:**
  - `"DecorationLayer is aria-hidden and passes clicks through"` (jsdom: computed `pointer-events` on a child is `none`, on `[data-cap-interactive]` `auto`).
  - `"ReplaceableFrame hides but keeps the box while pending"`.
  - `"every catalog part renders in /dev/ui"`: render the design reference set and collect `data-cap-part` tokens; equals the catalog names.
  - `"Sidebar draws the given brand instead of the Logo"`.
  - `findNestedBoxes` on the three primitives returns `[]`.
  - checks: each red fixture yields exactly its rule; the repo root yields `[]` (prove red first).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check:ui-parts`, `pnpm check` (`check:tokens`, `check:web-ui`). Expected: PASS.
- [ ] **Step 5: Commit** with a changeset (design): `feat(design): part hooks and decoration primitives`.

### Task 16: Document CSP with per-request nonces

Risk: high (a mistake blocks every page or opens script injection).

**Files:**
- Modify: `apps/web/src/proxy.ts` (nonce per document request: 16 random bytes base64; request header `content-security-policy` so Next applies the nonce, response header the same; `x-nonce` request header for the layouts), `apps/web/src/lib/headers.ts` (`NONCE_HEADER`), `apps/web/src/lib/server/page.ts` (`currentNonce()`)
- Test: `apps/web/test/csp.test.ts`, `apps/web/e2e/csp.spec.ts`

**Interfaces:**
- Produces: policy `script-src 'self' 'nonce-<n>'; object-src 'none'; base-uri 'none'` (dev adds `'unsafe-eval'`), on document responses only (not `/api`, `/plugin-ui`, `/_next/static`, the object-store proxy, which keep theirs); `currentNonce(): Promise<string>`.

- [ ] **Step 1: Write the failing tests:**
  - `csp.test.ts` `"a document response carries the policy with a fresh nonce"` (two requests → two different nonces); `"the /plugin-ui and object-store CSPs are untouched"`; `"/api responses carry no document CSP"`; `"dev adds unsafe-eval and production does not"`.
  - `csp.spec.ts` `"every page boots under the CSP"`: visit `/`, a conversation, `/settings/organization`, `/admin`, `/login`; no `securitypolicyviolation` event fires (listener installed via `addInitScript`), and hydration completes (an interactive control responds).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/csp.test.ts` and the e2e. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both, then the whole e2e suite once locally (`pnpm --filter @capybara-hq/web exec playwright test`). Expected: PASS.
- [ ] **Step 5: Commit** with a changeset on `@capybara-hq/capybara`: `feat(web): a nonce content security policy on every document`.

### Task 17: Web client host: import map, preloads, loading, safe mode, boundary

Risk: high (the loading path).

**Files:**
- Create: `apps/web/scripts/gen-client-host.mjs` (writes `apps/web/public/_capybara/client-host/<webBuild>/{react,react-jsx-runtime,react-dom,plugin-client}.mjs`; gitignored; run by `predev` / `prebuild`; `<webBuild>` = web version + sha256-12 of the shim contents), `apps/web/src/components/client-ext/{ClientHost.tsx,ClientExtensionsHead.tsx,host-api.ts,registry.ts,crash-budget.ts,reports.ts,boundary.ts}`, `apps/web/src/lib/query/client-extensions.ts`, `apps/web/src/lib/client-extensions.ts` (types copied from the kernel response)
- Modify: `apps/web/src/app/(app)/layout.tsx` (safe mode from the path's query, the head, `ClientHost` around `AppFrame`), `apps/web/src/lib/server/session.ts` (`getShell` adds `clientExtensionsQuery(orgId)` as a `section`; on `/admin/p/<plugin>/<id>` the admin read with `?plugin=`), `apps/web/src/lib/query/keys.ts`, `apps/web/src/lib/query/routes.ts`, `apps/web/src/app/error.tsx` and `apps/web/src/app/(app)/error.tsx` (以安全模式重新加载), `apps/web/package.json` (scripts), `.gitignore`, `apps/web/messages/{en,zh}.json`
- Test: `apps/web/test/client-host.test.tsx`, `apps/web/test/client-head.test.tsx`

**Interfaces:**
- Consumes: Tasks 5 (generated `api.generated.ts`), 10 (response), 15 (`SafeModeBanner`), 16 (`currentNonce`).
- Produces:
  - `ClientExtensionsHead({ set, nonce, safe })` (server): `<script type="importmap" nonce>` with `imports` and `integrity`, `preloadModule(url, { as: "script", integrity })` per entry, `<link rel="stylesheet" href precedence="extensions" integrity>` per style (none on admin pages).
  - `ClientHost({ set, safe, scope: "org" | "admin", children })`: in its first layout effect sets `globalThis.__CAPYBARA_CLIENT_HOST__ = { react, reactDom, jsxRuntime, pluginClient, design, apiVersion }`, then `import()`s each entry (10 s timeout), validates name / apiVersion / component slots against `set.items[].components`, keeps `useClientRegistry()`: `Record<plugin, { status: "loading" | "ready" | "failed" | "disabled"; definition?: ClientExtension }>`; applies the crash budget (`sessionStorage` `cap-client-disabled`, `<plugin>/<build>`); sends reports (once per `(plugin, build, contribution, kind)` per document); turns router transitions across a set change into `location.assign` (`boundary.ts`); disables stylesheets of plugins no longer listed.
  - Safe mode: `?safe-ui=1` → `safe: true` everywhere, nothing rendered by the head, `ClientHost` imports nothing and shows `SafeModeBanner` when the set is non-empty.

- [ ] **Step 1: Write the failing tests:**
  - `client-head.test.tsx` `"the head renders the import map with the nonce and integrity"`; `"safe mode renders no import map, preload or stylesheet"`; `"admin scope renders no stylesheet"`; `"an empty set renders nothing"`.
  - `client-host.test.tsx` (jsdom, `import()` mocked through a loader seam `ClientHost.load`): `"the host global is set before the first import"`; `"a module whose name differs is not activated and reported once"`; `"an unsupported apiVersion is reported with kind api"`; `"a component bound to another slot is dropped"`; `"a load that never resolves fails after 10 s"` (fake timers); `"three errors disable the plugin for the session"` (sessionStorage holds `fake-client/<build>`); `"safe mode imports nothing"`; `"a router push to /admin with a loaded set becomes location.assign"`; `"a plugin dropped from the set has its stylesheet disabled"`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/client-head.test.tsx apps/web/test/client-host.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check` (`check:web-ui`, `check:i18n`), `pnpm --filter @capybara-hq/web build`. Expected: PASS.
- [ ] **Step 5: Commit** with a changeset on `@capybara-hq/capybara`: `feat(web): load client extensions through the client host`.

### Task 18: `ExtensionSlot` renders components; replaceable slots; the new slots

Risk: high (fallback and isolation).

**Files:**
- Create: `apps/web/src/components/extension-ui/ClientComponentBlock.tsx`, `apps/web/src/components/extension-ui/ReplaceableSlot.tsx`
- Modify: `apps/web/src/components/extension-ui/ExtensionSlot.tsx` (`SlotArgs` / `SlotHost` for the four slots; component branches in every component slot; single slots), `apps/web/src/components/shell/AppFrame.tsx` (`shell.brand` into `Sidebar brand`, `shell.overlay` in `DecorationLayer`, not on admin pages), `apps/web/src/components/conversation/NewConversation.tsx` (`conversation.empty` around `Greeting`), `apps/web/src/components/conversation/ComposerBar.tsx` (`conversation.composer.frame`), `apps/web/src/lib/ui.ts` (`kind` gains `component`), `tools/checks/src/web-ui.ts` (`web-ui-extension-slot` adds `ClientComponentBlock`, `ReplaceableSlot`), `tools/checks/src/ui-slots.ts` (remove `PENDING_SLOTS`), `apps/web/messages/{en,zh}.json`
- Test: `apps/web/test/ui-slot-components.test.tsx`, `apps/web/test/ui-slot-replaceable.test.tsx`, `tools/checks/test/web-ui.test.ts`

**Interfaces:**
- Consumes: Tasks 9, 15, 17.
- Produces: `ClientComponentBlock({ c, args, hostProps })` (inside `BlockBoundary`, `HostContext` provider, nothing while loading); `ReplaceableSlot({ slot, args, builtin, extra })` (winner from `useSlotContributions`; `ReplaceableFrame pending` up to 1 500 ms; error boundary → builtin; composer check: after commit, the composer textarea `[data-cap-part~="composer"] textarea` must be in the document, else crashed).

- [ ] **Step 1: Write the failing tests:**
  - `ui-slot-components.test.tsx` `"a component renders in the properties section after its anchor"`; `"a throwing component shows the block's failure line and the rest renders"`; `"useView inside a component gets the slot's args"` (request carries `conversationId`); `"a component in conversation.panel gets close"`.
  - `ui-slot-replaceable.test.tsx` `"no winner renders the built-in"`; `"the winner renders and can wrap builtin"`; `"a throwing winner falls back to the built-in and reports once"` (two re-renders, one report); `"a loading winner hides the built-in for at most 1500 ms"` (fake timers: hidden at 1 499, visible at 1 500, swapped when the module arrives); `"a failed load renders the built-in"`; `"a composer frame that drops children falls back"`; `"safe mode renders the built-in"`; `"the overlay is not rendered on admin pages"`.
  - `web-ui.test.ts` `"ClientComponentBlock outside extension-ui is refused"` (red fixture).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check:ui-slots`, `pnpm check`, `pnpm --filter @capybara-hq/web build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): client components and replaceable slots`.

### Task 19: State hooks, run state and client events; `ThemeRef.key`

Risk: medium.

**Files:**
- Create: `apps/web/src/components/client-ext/run-state.tsx` (context + `usePublishRunState`), `apps/web/src/components/client-ext/events.ts` (log event → client event mapping, seq dedupe, history exclusion)
- Modify: `apps/web/src/components/conversation/ConversationView.tsx` (publish phase and failure; feed appended events), `apps/web/src/components/conversation/useConversation.ts` (expose appended events with a `live` flag), `apps/web/src/components/shell/AppFrame.tsx` (`capState` from run state + theme key; `motion` after hydration), `packages/kernel/src/themes/theme-state.ts` (`ThemeRef.key = "<plugin>/<theme file id>"`), `packages/kernel/src/themes/themes.schemas.ts`, `apps/web/src/lib/themes.ts`
- Test: `apps/web/test/client-events.test.ts`, `apps/web/test/cap-state.test.tsx`, `packages/kernel/test/themes/theme-ref.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `client-events.test.ts`: the eight rows of spec §7.5 as a table (`run_aborted` → `run.finished` `reason: "aborted"`; `user_message` with `dispatch` → nothing); `"history loaded on open emits nothing"`; `"a reconnect catch-up emits each event once by seq"`; `"a throwing listener does not stop the next"`.
  - `cap-state.test.tsx` `"the server render writes run=idle and the theme token"`; `"a run turns run=running then run=failed until the next run"`; `"motion=reduced follows the media query after hydration"`; `"leaving the conversation page writes run=idle"`.
  - `theme-ref.test.ts` `"ThemeRef.key is plugin/file id"`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** with changesets (kernel, capybara): `feat(web): run state hooks and client events`.

### Task 20: Admin and org pages: kill switch, client detail, replaceable picks, apply appearance

Risk: medium (roles everywhere: members see read-only state, never refused actions).

**Files:**
- Modify: `apps/web/src/app/(app)/admin/settings/view.tsx` (section 插件界面代码: switch + per-plugin `disabled` list), `apps/web/src/app/(app)/admin/extensions/…` detail view (界面代码: build, files, sizes, reports; 停用界面代码), `apps/web/src/app/(app)/admin/plugins/[itemId]/view.tsx` (应用此插件的外观: dry run → `DangerConfirm`-free `ConfirmDialog` listing changes → apply), `apps/web/src/app/(app)/extensions/view.tsx` (界面位置: single-slot selects 内置 / candidates; per plugin 应用此插件的外观 for org admins), the admin 界面位置 section in 平台设置, `apps/web/src/lib/query/*.ts` (queries and mutations with invalidation: the org's client set, arrangement, themes, platform theme), `apps/web/messages/{en,zh}.json`
- Test: `apps/web/test/admin-client-code.test.tsx`, `apps/web/test/apply-appearance.test.tsx`, `apps/web/test/ui-slot-arrangement-single.test.tsx`

- [ ] **Step 1: Write the failing tests:**
  - `"the kill switch writes clientExtensions.enabled and invalidates the client set"`.
  - `"the extension detail lists the build and reports and 停用界面代码 writes disabled"`.
  - `"apply appearance shows the dry run changes and applies on confirm"` (two requests: `dryRun: true`, then `false`; themes and arrangement queries invalidated).
  - `"members see no apply action and read-only picks"`.
  - `"the single-slot select writes use and shows follows-platform"`.
  - `findNestedBoxes` returns `[]` for each page.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check`, `pnpm --filter @capybara-hq/web build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): manage client code and apply a plugin's appearance`.

### Task 21: End-to-end suite

Risk: medium (it is the proof of the Review Focus).

**Files:**
- Create: `apps/web/e2e/client-extensions.spec.ts`, `apps/web/e2e/support/client-fixtures.ts` (install `fake-client` / `fake-client-broken` through the catalog file import, approve, enable)
- Modify: `apps/web/e2e/global-setup.ts` if fixtures need registering

- [ ] **Step 1: Write the tests** (each named as below):
  - `"the first document carries the CSP nonce, the import map and the plugin stylesheet"`.
  - `"part css applies at DOMContentLoaded"`: computed `outline-color` of the send button equals the fixture's.
  - `"the hud component appears with its view data"`.
  - `"a run switches data-cap-state to run=running and back"` (model-fake script with a slow step).
  - `"apply appearance picks the brand replacement and the theme"` (org admin flow; the brand test id visible; theme token applied).
  - `"safe mode loads zero plugin code"`: `?safe-ui=1`; no request to `/api/v1/client/` during load and after two client navigations; official brand visible; banner visible.
  - `"the kill switch removes everything after the shell read"`.
  - `"a broken plugin is disabled after three errors and the conversation still works"` (send a message, see the reply).
  - `"navigating into /admin is a document load and no plugin css is present"`.
  - `"a member of an org where the plugin is off gets 404 for its bundle url"` (direct fetch with the member's cookies).
- [ ] **Step 2: Run** `pnpm --filter @capybara-hq/web exec playwright test e2e/client-extensions.spec.ts`. Expected: PASS (all behaviour exists by now; any failure is a bug in the task that owns it, fixed there).
- [ ] **Step 3: Run** the whole e2e suite with `--workers=2` once to catch flakiness; fix waits, never add retries.
- [ ] **Step 4: Commit** `test(web): client extensions end to end`.

### Task 22: Docs and skills

Risk: low.

**Files:**
- Modify: `.agents/skills/writing-extension-ui/SKILL.md` (components, replaceable slots, parts, state hooks, overlay, events, delivery, safe mode, kill switch, crash budget, suggested appearance; description ≤ 1024 characters, no CJK), `.agents/skills/writing-plugins/SKILL.md` (the `client` section, `suggestedAppearance`, pack and check rules, bootstrap rule), `.agents/skills/writing-web-ui/SKILL.md` (`ClientHost`, `ReplaceableSlot`, `data-cap-part` literal rule, CSS layers, the CSP nonce), `.agents/skills/writing-extensions/SKILL.md` (the new permission keys), `docs/design/spec.md` (§2 layers, §3 the brand slot, §4 the decoration layer and parts), `docs/guide/extensions.md` (links to `ui-parts.md`), `docs/architecture.md` (already in Task 5: verify), `docs/superpowers/specs/2026-11-09-client-extensions-design.md` (status: implemented on the branch; §9.4 `<webBuild>` = web version + shim hash, the Next build id is unknown before the build; §9.2 the admin read takes `?plugin=`, as §11 implies; any other deviation recorded)
- Test: `pnpm check` (`check:skills-frontmatter`, `check:agent-docs`, `check:terms`)

- [ ] **Step 1: Write** the docs.
- [ ] **Step 2: Run** `pnpm check`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: client extensions in the skills and the design spec`.

---

## Follow-up tasks (not in this plan; exact order)

The acceptance of D4 needs `theme-cyberpunk` in `capybara-hq/plugins` built against published packages:

1. **F1 Release (core)**: after this plan merges, the next rc ships `@capybara-hq/plugin-sdk`, the first `@capybara-hq/plugin-client`, `@capybara-hq/plugin-tools`, `@capybara-hq/testing`, `@capybara-hq/kernel` and the images (`release.yml`). `plugin-client` is published with provenance like the other packages; check `pnpm changeset status` shows it in the pre-release.
2. **F2 Plugins PR (capybara-hq/plugins), after F1**: bump `plugin-sdk` / `plugin-tools` / `testing` and add `@capybara-hq/plugin-client` (dev and peer) to `plugins/theme-cyberpunk` at F1's versions. Then:
   - `src/index.ts`: `permissions.client: true`; components `run-hud` (`conversation.properties.section`, `after: "context"`, with `ctx.ui.view("run-hud")` returning `data` for the HUD), `scanlines` and `boot` (`shell.overlay`), `brand` (`shell.brand`), `hero` (`conversation.empty`).
   - `src/client.tsx`: `defineClientExtension` with the HUD (`useRunState`, `useView` data, a `Button` toggling sound, stored with `useClientStorage`), the scanline overlay, the boot animation once per session (`useClientStorage` scope `session`, skipped when `usePrefersReducedMotion()`), the glitch wordmark wrapping `builtin`, the hero; an `events` listener for `run.started` / `run.finished` / `approval.requested` / `tool.finished` playing sounds only when the toggle is on (off by default) and reduced motion is off.
   - `client/styles/cyberpunk.css`: chamfers (`clip-path`) on `card`, `button.primary`, `composer`, `section`, `dialog`; HUD colours on `[data-cap-state~="run=running"]`, `run=waiting`, `run=failed`; everything scoped to `[data-cap-state~="theme=theme-cyberpunk/night-city"]`; `@media (prefers-reduced-motion: reduce)` stops animation.
   - `client/assets/`: the sound files (`.ogg`).
   - `plugin.json`: `suggestedAppearance: { theme: "night-city", replacements: { "shell.brand": "brand", "conversation.empty": "hero" } }`.
   - `capybara-plugin check` with zero warnings (`client-css-selector`, `ui-part-unknown`); tests with `@capybara-hq/plugin-client/testing` for the HUD and the listener gating; release `plugin-theme-cyberpunk` through that repository's `capybara-plugin release`, and update its marketplace entry.
3. **F3 Acceptance (dev environment), after F2**: import `theme-cyberpunk` from the marketplace, approve the snapshot (`permissions.client`, `ui.component:*` marked sensitive), click 应用此插件的外观, then walk the spec §15 table; finish with `?safe-ui=1` and the kill switch returning the official UI. Record the result on the acceptance board.

## Self-review notes

- Spec coverage:
  - §4.1 packaging → Tasks 3, 6; bootstrap rule → Task 6. §4.2 package → Task 5.
  - §5.1 contributions → Tasks 2, 9; §5.2 component views → Tasks 2, 9; §5.3 props → Tasks 5, 18; §5.4 review → Task 7, org upload gate → Task 10 (delivery) and Task 8 (import).
  - §6.1-§6.2 → Tasks 1, 15 (`Sidebar brand`), 18; §6.3 `use` → Tasks 9, 20; §6.4 fallback → Task 18; §6.5 suggested appearance → Tasks 3, 12, 20.
  - §7.1 parts → Tasks 4, 15; §7.2 layers → Tasks 6, 8, 14; §7.3 state → Tasks 15, 19; §7.4 overlay → Tasks 15, 18; §7.5-§7.6 events and run state → Tasks 5, 19; §8 → F2.
  - §9.1 storage → Task 8; §9.2-§9.3 routes and access → Tasks 10-11; §9.4 loading → Task 17; §9.5 CSP → Task 16; §9.6 where code runs → Tasks 10, 17, 18.
  - §10 safety → Tasks 10 (kill switch), 11 (reports), 17 (safe mode, budget), 18 (boundaries), 20 (pages). §11 → Tasks 17-19. §12 → Tasks 8, 10, 11. §14 → each task; e2e → Task 21. §15 → F2-F3.
- Type consistency: `UiKind` is extended once (Task 1) and read by the kernel (Task 9) and the generated web copy; `PluginClientSection` and `CLIENT_LIMITS` live in the SDK (Task 3) and are read by pack (Task 6) and the kernel (Task 8); `CLIENT_API_VERSION` is exported by both the SDK (for the kernel) and `plugin-client` (for plugins), and `check:plugin-client-api` plus a SDK test pin them equal; `ClientExtensionsResponse` has one shape (Task 10) copied into `apps/web/src/lib/client-extensions.ts` (Task 17); the arrangement entry union is defined in Task 9 and used by Tasks 12 and 20.
- Proportion: the eight high-risk tasks (7, 8, 9, 10 on the kernel side; 14, 16, 17, 18 on the design and web side) carry explicit negative tests and are reviewed alone. Checks are proven red before they go green (Tasks 4, 5, 6, 15, 18).
- Waves (for `wave-planned-subagent-development`; shared files serialize: SDK `ui.ts` / `ui-slots.ts` / `permissions.ts` / `index.ts` / `api/plugin-sdk.api.md` (Tasks 1, 2, 3, 4); kernel `ui/views.ts`, `identity/settings.ts` (9, 10); `platform/exclusions.ts` (10, 11, 12); `errors.ts` (8, 10); `client/client.controller.ts` (10, 11); web `messages/*.json` (7, 8, 10, 17, 18, 20), `lib/query/routes.ts` and `keys.ts` (17, 20), `app/(app)/layout.tsx` (17), `AppFrame.tsx` (18, 19); design `styles/*` (14, 15); `tools/checks/src/cli/all.ts` and `README.md` (4, 5, 6)):
  1. {1, 14, 16}
  2. {2, 5}
  3. {3, 7}
  4. {6, 9}
  5. {4, 8, 13}
  6. {10, 15}
  7. {11, 17, 19}
  8. {12, 18}
  9. {20}
  10. {21, 22}

  Ordering notes: Task 4 waits for Task 5 (it writes the package's parts copy) and must not share a wave with Task 6 (both edit `tools/checks/README.md`); Task 15 follows Task 4 (it adds the render rules to `ui-parts.ts`); Tasks 17 and 19 share the `client-ext/` directory but no file, and only Task 17 touches messages in wave 7; Task 18 follows both because it edits `AppFrame.tsx` after Task 19. High-risk tasks (7, 8, 9, 10, 14, 16, 17, 18) each get their own review on the most capable model, never batched; Task 16 (CSP) and Task 10 (client file access) are trust-boundary reviews, Task 8 is the migration review.
