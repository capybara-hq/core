# Extension config forms — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** extensions get localized display names and config forms drawn from declarative `x-ui`
hints by one web renderer (repeaters, rows, item secrets), replacing `SchemaForm` and the JSON-secret
stopgap.

**Architecture:** the SDK owns hints (`ui()`), the zod → JSON Schema conversion (`configJsonSchema`)
and their validation (`validateConfigUi`); the packer writes the schemas into `plugin.json`, the kernel
passes them through (stripping invalid hints), adds display names, issue `segments` and record secret
entry operations; three new design components and one `config-form` module in the web draw every
config form (deployment, org, channel connection, install wizard, upgrade dialog).

**Tech Stack:** TypeScript, zod 4 (`.meta()`, `z.toJSONSchema`), NestJS kernel + Kysely/PG, Next 16
App Router (server page + client view), `@capybara-hq/design`, vitest, Playwright (CI only).

**Spec:** `docs/superpowers/specs/2026-11-03-extension-config-forms-design.md` (§ numbers below
refer to it). This plan covers release step 1 (§8.1, core, this acceptance batch). Steps 2 and 3
(plugins repo PR, core pin move) need the SDK published as the next rc and are listed at the end as
follow-ups, not executed here.

## Rulings made while planning

- **P1 — `LocalizedText` already exists** in the SDK (`tool.ts`: `{ zh, en } | string`). Config hints
  use the existing `LocalizedName` (`{ zh; en }`, both required) instead of a second
  `LocalizedText`; spec §3.1's `LocalizedText` reads as `LocalizedName` everywhere. Cost if wrong: a
  type alias rename before the SDK rc.
- **P2 — `ui` name**: the SDK already exports `UiView`, `UI_LIMITS`, … for extension UI, but no value
  named `ui`; the spec's `ui(schema, hints)` stays. Types are prefixed `ConfigUi*` to keep them apart.
- **P3 — open questions (U-R1)**: Q1 the view lists the keys set for hinted record secrets (endpoint
  names, not secrets); Q2 presets carry no model rows; Q3 `plugin-config-labels` is enforced from the
  start (error, not warning).
- **P4 — next migration number** is `0065_extension_display_name.sql`.
- **P5 — channel plugin options** and **org extension list** get `displayName` in the same task as the
  admin view (Task 3); the web label sweep is Task 8.

## Global Constraints

- Worktree `/Users/grant/Capybara/core/.claude/worktrees/fix-rc2-acceptance`, branch
  `fix/rc2-acceptance`. Identity `Grant <284885069@qq.com>`; Conventional Commits in English; body
  lines ≤ 100; end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Implementers never
  push.
- Do not start or stop the user's dev stack (ports 3000 / 8080, hot-reloads from this worktree); keep
  the app compiling at every commit. No `next build`, no Playwright runs locally.
- Before each commit: `pnpm lint`, `pnpm typecheck`, `pnpm check`, and `pnpm exec vitest run <the
  packages touched>` from the repo root (kernel tests need `docker compose -f docker/compose.dev.yaml`
  services, already running).
- New code comments in English. Model-facing text English; UI text via i18n zh + en under spec.md
  §7.1 copy rules (full sentences end with 。, labels don't; 「新建」; full-width punctuation).
- `apps/web` writes no styles; visual changes only in `packages/design` (component + spec.md entry
  with size table and state list + reference page + `apps/web/visual/accepted.ts`).
- SDK public API change: `pnpm gen:sdk-api` + a changeset bumping `@capybara-hq/plugin-sdk`
  (pre mode `rc`). Kernel, plugin-tools and `@capybara-hq/capybara` changes each get a changeset;
  web is in the capybara fixed group.
- Package JSON Schemas regenerate with `pnpm gen:package-schemas`.
- Every new check is red first (a fixture that fails it), listed in AGENTS.md "CI and checks" with
  "full: cheap".
- Limits (spec §3.3): `label` ≤ 100, `help` ≤ 500, `placeholder` ≤ 200 characters per language, both
  non-empty; `x-ui` JSON per schema ≤ 64 KiB; ≤ 200 options, ≤ 20 presets, ≤ 20 sections;
  `configSchemas.*` ≤ 256 KiB each.
- Secrets are stored only at fixed object paths; hints may draw a secret elsewhere, never store it
  elsewhere; no secret value ever appears in a view, an audit or a log.

## Review Focus

1. **Endpoint renamed after its key was set**: the key follows the new name (`renameFrom`), the old
   record key is gone, and a rename plus a new key in one save applies both. Test in Task 4.
2. **Endpoint names containing dots** (`a.b`): issues map through `segments`, never the joined
   `path`; `apiKeys.a.b` lands on endpoint `a.b`'s key input. Tests in Tasks 2 and 7.
3. **A field given by the startup config** (env / file / Nacos) that is an array: the whole repeater
   is read-only, and a `secretEntries` path given by startup config → 409. Tests in Tasks 4 and 7.
4. **An extension not loaded on this replica** (pending approval, disabled) packed before this change:
   the flat fallback still renders and saves; packed after it: the rich form, `validated: false`.
   Test in Task 2.
5. **Half-typed drafts**: an empty number input, a removed required item, an empty new endpoint name;
   the client blocks the save with the field's message instead of sending `NaN` / `""` and getting a
   generic 400. Test in Task 7.

---

### Task 1: SDK — hints, conversion and validation

**Files:**
- Create: `packages/plugin-sdk/src/config-ui.ts`, `packages/plugin-sdk/test/config-ui.test.ts`
- Modify: `packages/plugin-sdk/src/secret.ts` (merge meta), `packages/plugin-sdk/src/index.ts`
  (export), `packages/plugin-sdk/src/plugin-manifest.ts` (`extension.configSchemas`),
  `packages/plugin-sdk/schemas/plugin.v1.schema.json` (generated),
  `packages/plugin-sdk/api/plugin-sdk.api.md` (generated), `.changeset/*.md`

**Interfaces:**
- Produces (exact names, spec §3.1 with ruling P1):
  `ConfigWidget`, `ConfigUiOption`, `ConfigUiSection`, `ConfigUiPreset`, `ConfigUiItemSecret`,
  `ConfigUiHints` (texts typed `LocalizedName`; `placeholder?: string | LocalizedName`),
  `ui<T extends z.ZodTypeAny>(schema: T, hints: ConfigUiHints): T`,
  `type JsonSchema = Record<string, unknown>`,
  `configJsonSchema(schema: z.ZodTypeAny): JsonSchema`,
  `interface ConfigUiProblem { path: string; message: string }`,
  `validateConfigUi(schema: JsonSchema, level: "deployment" | "org" | "connection"): ConfigUiProblem[]`,
  `CONFIG_UI_LIMITS` (the numbers of Global Constraints),
  `PluginExtensionSection.configSchemas?: { deployment?: JsonSchema; org?: JsonSchema }`.

- [ ] **Step 1: Write the failing tests** in `config-ui.test.ts`:
  - `ui()` then `secret()` and `secret()` then `ui()` both keep `{ secret: true, ui }`; `hot` meta
    survives `ui()`.
  - `configJsonSchema` of `z.object({ a: ui(z.string(), { label: {zh:"甲",en:"A"} }), k:
    secret(z.string()).meta({hot:true}) })`: `properties.a["x-ui"].label.en === "A"`,
    `properties.a.title === "A"`, `properties.k["x-secret"] === true`, `properties.k["x-hot"] ===
    true`, no `hot` / `secret` / `ui` / `$schema` keys anywhere.
  - Scrub (moved from the kernel's tests, plus): `x-ui.options` and `x-ui.presets` removed under a
    secret node; a property named `default` is still traversed.
  - `validateConfigUi`: one red case per §3.3 rule, each asserting the problem's `path`: text too
    long / missing language; option value not in enum; duplicate option value; `switch` on a string;
    `presets` on an array of strings; `layout: "row"` on an object with an object property; title
    template naming an unknown field; preset key unknown / wrong type / secret; `secrets[].path` not a
    secret record; `keyBy` not a string property; `secrets` at level `org`; `section` without root
    `sections`; `messages` below the root; disallowed hint (`widget`) on a secret node; x-ui > 64 KiB.
    One green case: the openai-compatible-shaped schema of spec §6 has no problems.
  - `parsePluginManifest` accepts `extension.configSchemas` and rejects one over 256 KiB.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/config-ui.test.ts`; expected
  FAIL (module not found).
- [ ] **Step 3: Implement.** `secret()` and `ui()` both write
  `schema.meta({ ...(schema.meta() ?? {}), … })`. `configJsonSchema` is the kernel's
  `configToJsonSchema` (`packages/kernel/src/extensions/config-json-schema.ts`) moved here, with the
  override also turning `hot` into `x-hot`, `ui` into `x-ui`, and filling `title` / `description`
  from `x-ui.label.en` / `x-ui.help.en` when absent; the scrub also drops `x-ui.options` /
  `x-ui.presets` under a secret. `validateConfigUi` walks `properties` / `items` /
  `additionalProperties` and reports problem paths as dot paths of property names (`endpoints.items.
  models`). Export from `index.ts`.
- [ ] **Step 4: Run** the test file and `pnpm exec vitest run packages/plugin-sdk`; expected PASS.
- [ ] **Step 5:** `pnpm gen:sdk-api`, `pnpm gen:package-schemas`; add the changeset (SDK minor
  bump note: "config UI hints"). Run lint, typecheck, check.
- [ ] **Step 6: Commit** `feat(sdk): config UI hints, configJsonSchema and validateConfigUi`.

### Task 2: Kernel — pass-through, load-time validation, static schemas, issue segments

**Files:**
- Modify: `packages/kernel/src/extensions/config-json-schema.ts` (re-export the SDK; no copy),
  `config-issues.ts`, `host.ts` (load: validate hints), `deployment-config.ts`
  (`staticDeploymentSchema`, `render`), `org-config.ts`, `channels/connections.service.ts`,
  `packages/kernel/src/index.ts` (keep its export names working)
- Test: `packages/kernel/test/extensions/config-json-schema.test.ts` (move SDK-covered cases out,
  keep pass-through), `packages/kernel/test/extensions/config-ui-load.test.ts`, the existing
  deployment-config / org-config tests

**Interfaces:**
- Consumes: Task 1's `configJsonSchema`, `validateConfigUi`, `PluginExtensionSection.configSchemas`.
- Produces: `ConfigIssue { path: string; segments: (string | number)[]; message: string;
  messageKey?: string }`; `toIssues(error, messages?: Record<string, unknown>)` where `messages` is
  the root `x-ui.messages` (a custom issue whose `params.ui` names a key gets `messageKey`);
  `DeploymentConfigView.schema` non-null for unloaded installs whose package carries
  `configSchemas.deployment` (with `validated: false`).

- [ ] **Step 1: Failing tests:**
  - `toIssues` on a refine with `params: { ui: "duplicateEndpoint" }` and messages containing it →
    `messageKey: "duplicateEndpoint"`; without the key in messages → no `messageKey`; a path
    `["apiKeys", "a.b"]` → `segments: ["apiKeys", "a.b"]`, `path: "apiKeys.a.b"`.
  - Load: an extension (test extension in the test file, through `startTestKernel` or the host's
    unit seam used by the existing host tests) whose deployment schema has an option outside its enum
    loads, its view's schema has no `x-ui`, one warning logged with the extension name and version,
    status detail mentions the hints.
  - Static: an install record whose package section has `configSchemas.deployment` and is pending
    approval → `GET …/config` returns that schema with `validated: false`; a section without it →
    `schema: null` (today's flat fallback).
  - Org config and channel connection schemas carry `x-ui` / `x-hot` the same way.
- [ ] **Step 2: Run** them; expected FAIL.
- [ ] **Step 3: Implement.** Strip `x-ui` recursively from the cached JSON Schema when
  `validateConfigUi` reports problems (deployment and org level at load; connection level when the
  channel schema is first converted); warn once per `<name>@<version>` through the host's logger.
  `staticDeploymentSchema` returns `schema` from `section.configSchemas?.deployment` and
  `DeploymentSchemaInfo` gains `jsonSchema?: JsonSchema` so `render` uses it when there is no zod
  schema. `configSchemas` is excluded from the `manifest_mismatch` comparison (it lives beside
  `manifest`, so confirm the comparison reads only `manifest`).
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/extensions packages/kernel/test/channels`;
  expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): pass config UI hints through; issue segments and message keys`.

### Task 3: Kernel — extension display names

**Files:**
- Create: `packages/kernel/src/migrations/0065_extension_display_name.sql`,
  `packages/kernel/test/extensions/display-name.test.ts`
- Modify: `packages/kernel/src/db` types (`extension_packages.display_name`),
  `extensions/installs.ts` (`ingest` writes it), config-declared loading in `host.ts` (reads the
  directory's `.capybara-plugin/plugin.json` `displayName` when present), a new resolver in
  `extensions/display-name.ts`, `permission-view.ts` (`AdminExtensionView`), the org extension list
  (`org-config.controller.ts`), the models list (`models/purposes.ts` providers), the channel plugin
  options (`channels/*`), `deployment-config.ts` (view), `plugins/model-fake/.capybara-plugin/plugin.json`
  (`displayName: { zh: "模拟模型", en: "Fake model" }`)

**Interfaces:**
- Produces: `ExtensionDisplayNames` provider with `get(name: string): Promise<LocalizedName | null>`
  and `many(names: string[]): Promise<Map<string, LocalizedName | null>>` (one query each: installed
  package's `display_name`, else the live catalog item of the same name, else null). Response fields:
  `AdminExtensionView.displayName`, org extension list items `displayName`,
  models `providers[].displayName`, channel plugin options `displayName`,
  `DeploymentConfigView.displayName` — all `LocalizedName | null`.

- [ ] **Step 1: Failing tests:** migration applies on a DB with existing `extension_packages` rows
  (column null); ingesting a tgz whose `plugin.json` has `displayName` stores it; resolver falls back
  to the catalog item; each of the five APIs returns `displayName` (model-fake → `模拟模型`).
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement** (migration with `ADD COLUMN IF NOT EXISTS display_name jsonb`; list
  endpoints call `many` once per response, no per-row query).
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/extensions packages/kernel/test/models
  packages/kernel/test/channels plugins/model-fake`; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): extension display names in every extension and model API`.

### Task 4: Kernel — record secrets drawn per item

**Files:**
- Modify: `packages/kernel/src/extensions/deployment-config.ts`, its controller's DTO
  (`createZodDto` body), `deployment-config-store.ts` if a helper belongs there
- Test: `packages/kernel/test/extensions/deployment-config-secret-entries.test.ts`

**Interfaces:**
- Consumes: the JSON Schema's `x-ui.secrets[].path` (Task 1) to know the hinted paths.
- Produces: `DeploymentConfigField.keys?: string[]` (only on secret record fields a hint names; sorted);
  `put(plugin, values, actor, actorTokenId, secretEntries?: SecretEntry[])` with
  `SecretEntry { path: string; key: string; value?: string | null; renameFrom?: string }`;
  PUT body `{ values, secretEntries? }`.

- [ ] **Step 1: Failing tests:**
  - set `{path:"apiKeys", key:"deepseek", value:"sk-1"}` → view `keys: ["deepseek"]`, `set: true`,
    no value anywhere in the response or the audit row (`changedPaths: ["apiKeys"]`).
  - rename `{key:"ds", renameFrom:"deepseek"}` → keys `["ds"]`, the decrypted record holds `sk-1`
    under `ds`; rename plus `values.endpoints` renaming the endpoint in the same PUT validates.
  - remove `{key:"ds", value:null}` → keys `[]`.
  - a path no hint names → 400 `validation_failed`; a path set by startup config (test
    `extensionConfigSources`) → 409 `extension.config_readonly`.
  - two concurrent PUTs each setting a different key → both keys present (the lock serializes).
  - an unhinted secret record field still reports only `set`.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement** inside `write()` after `configLock.lock`: decrypt the record from
  `before`, apply entries in order (rename, then set / remove), put it into `next` at `path`, add
  `path` to the changed set, then the existing validate / encrypt / audit flow.
- [ ] **Step 4: Run** the deployment-config tests; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): secret record entries for hinted deployment config fields`.

### Task 5: plugin-tools — pack writes schemas; three new checks

**Files:**
- Modify: `packages/plugin-tools/src/pack/pack.ts` (`bundleExtension`: after importing the module,
  `configJsonSchema` of its deployment / org schemas; refuse on `validateConfigUi` problems; write
  `extension.configSchemas`), `src/check/run.ts` (new check "Config forms"),
  `src/check/release-metadata.ts` (`release-display-name`)
- Create: `src/check/config-forms.ts`; fixtures `fixtures/plugin-config-ui/`,
  `fixtures/plugin-config-labels/`, `fixtures/release-metadata/` gains a plugin without `displayName`
- Test: `packages/plugin-tools/test/pack.test.ts`, `test/check/config-forms.test.ts`,
  `test/check/release-metadata.test.ts`
- Docs: AGENTS.md "CI and checks" (three rules, full: cheap), `.agents/skills/writing-plugins`
  (packer writes `configSchemas`)

**Interfaces:**
- Consumes: Task 1.
- Produces: rules `plugin-config-ui`, `plugin-config-labels`, `release-display-name`.

- [ ] **Step 1: Failing tests:** packing a plugin with a hinted schema writes `configSchemas` and two
  packs are byte-identical; packing invalid hints throws naming the problem path; `config-forms`
  check red on each fixture (invalid hint; public plugin field without zh+en label, a hinted
  per-item secret record skipped); release metadata red on a public plugin without `displayName`,
  green on `plugins/example-*` private ones.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-tools`; expected FAIL.
- [ ] **Step 3: Implement**; `plugins/model-fake` passes (it got `displayName` in Task 3; its config,
  if any, gets labels here).
- [ ] **Step 4: Run** `pnpm exec vitest run packages/plugin-tools tools/checks` and `pnpm check`;
  expected PASS. Changeset for plugin-tools.
- [ ] **Step 5: Commit** `feat(plugin-tools): pack config schemas; config form and display name checks`.

### Task 6: Design — Repeater, FieldRow, KeyValueEditor

**Files:**
- Create: `packages/design/src/controls/repeater.tsx`, `field-row.tsx`, `key-value-editor.tsx`,
  their reference blocks under `packages/design/src/reference`,
  `apps/web/visual/repeater.interaction.spec.ts`
- Modify: `packages/design/src/controls/index.ts`, `packages/design/src/styles/*.css` (one file per
  component, as siblings do), `docs/design/spec.md` (§6.26 Repeater, §6.27 FieldRow,
  §6.28 KeyValueEditor — renumbered from the config spec's §6.24–6.26, which are taken), design i18n
  strings (`packages/design/src/i18n.ts`: add, remove, undo, move up / down, advanced, blank),
  `apps/web/visual/accepted.ts`
- Test: `packages/design/test/repeater.test.tsx`, `field-row.test.tsx`, `key-value-editor.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  interface RepeaterItem { key: string; title?: ReactNode; subtitle?: ReactNode; body: ReactNode;
    invalid?: boolean; collapsed?: boolean }
  function Repeater(props: { label: string; items: RepeaterItem[]; addLabel: string;
    onAdd(presetId?: string): void; presets?: { id: string; label: string; help?: string }[];
    onRemove(key: string): () => void; onMove?(key: string, to: number): void; onToggle?(key: string): void;
    min?: number; max?: number; disabled?: boolean; empty?: string }): JSX.Element
  function FieldRow(props: { children: ReactNode; advanced?: ReactNode; first?: boolean }): JSX.Element
  function KeyValueEditor(props: { label: string; value: [string, string][];
    onChange(next: [string, string][]): void; disabled?: boolean;
    keyLabel: string; valueLabel: string }): JSX.Element
  ```
  `onRemove(key)` removes at once and returns a restore function; the Repeater shows an undo toast
  (the toast the design package already has) whose action calls it. Documented in spec.md.

- [ ] **Step 1: Failing tests:** Repeater renders items with title / subtitle; add button vs preset
  menu (presets + "Blank"); remove disabled at `min`, add disabled at `max`; Alt+↑/↓ calls `onMove`;
  after add, focus moves to the new item's first focusable field; `disabled` disables add / remove /
  move. FieldRow wraps (class/state attribute present below the narrow breakpoint per spec.md);
  KeyValueEditor adds / edits / removes a row.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/design`; expected FAIL.
- [ ] **Step 3: Implement** with existing pieces (`IconButton`, `Menu`, `Button`, `Disclosure`,
  `Field`, `Input`); spec.md entries with size table and state list; reference blocks; accepted.ts
  entries; the interaction spec (add, preset menu, remove with undo, keyboard reorder, focus) for CI.
- [ ] **Step 4: Run** design tests, `pnpm check` (web-ui, tokens, design-char-icon); expected PASS.
- [ ] **Step 5: Commit** `feat(design): Repeater, FieldRow and KeyValueEditor for config forms`.

### Task 7: Web — the config form renderer, every caller moved

**Files:**
- Create: `apps/web/src/components/config-form/model.ts`, `ConfigForm.tsx`, `deployment.ts`,
  `org.ts`, `channel.ts`; tests `apps/web/test/config-form-model.test.ts`,
  `apps/web/test/config-form.test.tsx`, `apps/web/test/config-form-adapters.test.ts`
- Modify: `apps/web/src/components/ExtensionDeploymentConfig.tsx`,
  `apps/web/src/app/(app)/admin/extensions/[name]/view.tsx`,
  `apps/web/src/app/(app)/settings/extensions/view.tsx`, `apps/web/src/app/(app)/channels/new/view.tsx`,
  `apps/web/src/app/(app)/channels/[id]/view.tsx`, `apps/web/src/components/CatalogInstallWizard.tsx`,
  `apps/web/src/components/PluginUpgradeDialog.tsx`, `apps/web/src/lib/*` types for the new view
  fields (`keys`, `segments`, `messageKey`, `displayName`), messages zh / en
- Delete: `apps/web/src/components/SchemaForm.tsx`, `apps/web/test/schema-form.test.tsx`, the
  `secretJson` / `x-secret-json` stopgap

**Interfaces:**
- Consumes: Tasks 2–4 view fields, Task 6 components.
- Produces:
  ```ts
  type ConfigNode = /* object | array | record | scalar | secret | itemSecret | json */;
  function buildTree(schema: JsonSchema, locale: "zh" | "en"): ConfigNode;
  function toDraft(node: ConfigNode, value: unknown): Draft;
  function fromDraft(node: ConfigNode, draft: Draft): { value: unknown; problems: NodeProblem[] };
  function mapIssues(node: ConfigNode, value: unknown, issues: ConfigIssue[]):
    { byNode: Map<string, string>; form: string[] };
  ```
  `ConfigForm` props: `{ schema; value; meta: Record<string, { readonly?: string; secretSet?: boolean;
  secretKeys?: string[]; hot?: boolean }>; issues; onChange(value, secretEntries) }`. Adapters build
  the PUT body: `deployment.ts` → `{ values (changed field paths only), secretEntries }`;
  `org.ts` / `channel.ts` → whole object with `secrets: [{ path, set }]` keep / clear / replace.

- [ ] **Step 1: Failing tests:**
  - model: the spec §6 schema builds endpoints → repeater of objects with an itemSecret after
    `baseUrl` and a models repeater of `row` items; ordering by `order` then declaration; sections;
    draft ⇄ value round-trip; an empty number draft → problem "required" not `NaN`; a new endpoint
    with empty `name` → problem on `name`.
  - issue mapping: `["endpoints",0,"models",1,"documents"]` → that node (and its card marked
    expanded); `["apiKeys","a.b"]` → endpoint `a.b`'s key input; an array-level issue → the
    repeater; unknown → form-level; `messageKey` → the hint message in the locale.
  - adapters: adding an endpoint with a key → `secretEntries` set; renaming an endpoint with a key
    set → `renameFrom`; removing it → `value: null`; unchanged fields not sent.
  - `ConfigForm` without any `x-ui` renders labels from keys, nested objects as fieldsets, arrays of
    objects as repeaters, unions as JSON textareas; a readonly array disables add / remove / move.
  - The admin extension page's server read provides `initial`; the client does no fetch on first
    render (follow the existing SSR test pattern for that page).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web`; expected FAIL.
- [ ] **Step 3: Implement**, move every caller, delete `SchemaForm`; footer keeps the hot / reload
  note; pending-config callout lists missing fields by label.
- [ ] **Step 4: Run** `pnpm exec vitest run apps/web packages/design tools/checks`, `pnpm check`,
  `pnpm typecheck`; expected PASS. Check the running dev web at
  `http://localhost:3000/admin/extensions/openai-compatible` renders (the installed openai-compatible
  has no hints yet: the generic structured form must work, endpoints as a repeater).
- [ ] **Step 5: Commit** `feat(web): one config form renderer for every extension config`.

### Task 8: Web — extension labels everywhere and the label check

**Files:**
- Create: `apps/web/src/lib/extension-label.ts`, `apps/web/test/extension-label.test.ts`,
  `tools/checks/fixtures/web-ui/provider-label/` (red fixture)
- Modify: `apps/web/src/components/PurposeEditor.tsx`, `AgentForm.tsx`, `AgentList.tsx`,
  `apps/web/src/lib/models.ts`, `apps/web/src/app/(app)/agents/[id]/view.tsx`, admin and org
  extension lists / detail (title, breadcrumb last segment, id as muted meta), setup checklist and
  pending-config callouts, channel plugin picker; `tools/checks/src/web-ui.ts` (rule
  `web-ui-extension-label`), AGENTS.md

**Interfaces:**
- Produces: `extensionLabel(x: { name: string; displayName?: LocalizedName | null }, locale: "zh" |
  "en"): string` and `modelLabel(provider: { name; displayName }, model: string, locale): string`
  (`"OpenAI 兼容 / deepseek/deepseek-flash"`; falls back to the id).

- [ ] **Step 1: Failing tests:** helper fallbacks; the check rule red on the fixture
  (`` `${p.provider} / ${m.id}` `` in a component), green on the helper file itself.
- [ ] **Step 2: Run**; expected FAIL.
- [ ] **Step 3: Implement**; option values stay `provider/model`.
- [ ] **Step 4: Run** `pnpm exec vitest run apps/web tools/checks`, `pnpm check`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): extension display names in lists, titles and model pickers`.

### Task 9: Test fixture and e2e

**Files:**
- Create: `packages/testing/fixtures/extensions/fake-config-form/` (pack layout like its siblings:
  an openai-compatible-shaped deployment schema with the spec §6 hints, `displayName`
  `{ zh: "表单样例", en: "Form sample" }`), `apps/web/e2e/extension-config-form.spec.ts`
- Modify: whatever registers fixture extensions for the e2e stack (follow how `fake-tools-ui` is
  installed there), `tools/ci/test-plugins.json` only if the check requires it

- [ ] **Step 1:** fixture packs with `packFixture` (a vitest case in `packages/testing/test` asserting
  `configSchemas.deployment["x-ui"]` is present).
- [ ] **Step 2:** e2e spec (runs in CI only): admin opens the fixture's config, adds the DeepSeek
  preset, sets its key, adds a model row, saves; reloads and sees the endpoint card with "已设置",
  and the list row reads 「表单样例」 with the id as meta.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/testing`, `pnpm typecheck`, `pnpm check`;
  expected PASS.
- [ ] **Step 4: Commit** `test: fake-config-form fixture and the config form e2e`.

---

## Follow-ups (not in this batch)

1. **Plugins repo PR** (after the next core rc is on npm): SDK devDependency and every extension's
   `sdk` range raised; `displayName` on all 13 plugins; hints for openai-compatible (spec §6) and the
   table in §7; changesets; `capybara-plugin marketplace --write`; merged and published by its
   release workflow.
2. **Core pin move**: `bootstrap.json` versions + integrity for openai-compatible and object-store-s3,
   `marketplace.commit`, compose sandbox contexts; `pnpm check:bootstrap --network`; extend
   `admin-extensions.spec.ts` with the real openai-compatible flow against `startFakeModelServer`.
