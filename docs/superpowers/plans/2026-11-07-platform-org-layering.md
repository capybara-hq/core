# Platform / org layering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** org admins can turn off `all`-scope items, override the config fields an extension marks
overridable (copy on edit, compare, take, go back), get that effective config in every org-bound
call, and turn off single extension tools.

**Architecture:** the SDK gets a field-level meta `orgAccess()` (`x-org` in the JSON Schema). The
kernel reads levels from the deployment schema, relaxes overridable fields in the load gate, keeps
org copies in a new table (secrets under a new key prefix, never copied from the platform), and
resolves an **effective config** per (org, extension) that every org-bound call site passes to the
extension next to today's `orgConfig`. Scope `all` loses its lock through `wantedOn` / `switchable`.
Tool switches are rows filtered in `ToolRegistry.resolve` and refused in the pipeline.

**Tech Stack:** NestJS + Fastify kernel, Kysely on PG, Redis cache, zod 4 (`z.toJSONSchema`), Next web
app with TanStack Query and `@capybara-hq/design`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-07-platform-org-layering-design.md` (cited "A §n"), which
amends `docs/superpowers/specs/2026-11-05-plugin-component-management-design.md` ("PCM"). Research
map with file:line facts: `.superpowers/sdd/layering-research-notes.md` (cited "R§n"; lines at
`bbde58f8`).

## Global Constraints

- Next migration number `0086`; one migration for the work: `packages/kernel/src/migrations/0086_org_layering.sql`.
  Expand-only; `IF NOT EXISTS`; no data rewrite.
- Levels: `hidden` (no meta, default), `readonly`, `override`, on **top-level** properties of the
  deployment schema only; org-schema fields are org only. JSON Schema key `x-org` with values
  `"readonly" | "override"`. A secret with `readonly` is invalid.
- Platform secrets never reach an org: not in an org API response, not in a diff, not copied into a
  copy, not in the effective config of an org that has a copy (A §5.4, §5.5). Hidden fields are
  omitted from org API responses entirely.
- A copy's secrets live in `capybara.secrets` under the org, key `plugin-override:<plugin>:<path>`
  (must not start with `plugin-config:`, R§4).
- Built-in plugins stay locked on (`extension.required`, `plugin.scope_locked` for them only).
- SDK changes are additive: one changeset bumping `@capybara-hq/plugin-sdk` (minor), API snapshot
  regenerated with `pnpm gen:sdk-api`; `plugin.json`'s static `configFields` stays unchanged (strict
  schema, R§1: levels are read from `configSchemas.deployment` and the zod meta).
- Kernel conventions (AGENTS.md): `@Injectable` providers with `@Inject` on every constructor
  parameter; writes in `@Transactional()`; cache evictions and bus publishes after commit; DTOs via
  `createZodDto` with `@ZBody` / `@ZParam`; new error codes registered in `errors.ts` with web copy in
  both message files.
- Web: design templates and components only, no styles (`check:web-ui`); reads `defineQuery` with
  keys from `lib/query/keys.ts`; writes `useAppMutation` naming invalidated keys; zh and en
  messages; zh says 智能体, 平台, 超级管理员, 组织管理员, never 企业 or the Latin "agent".
- Audit actions: `extension.org_override_saved`, `extension.org_override_taken`,
  `extension.org_override_reset`, `extension.tool_switched`.
- Changesets: `@capybara-hq/plugin-sdk` minor, `@capybara-hq/plugin-tools` minor,
  `@capybara-hq/kernel` minor, `@capybara-hq/web` minor.
- Everything local until the maintainer asks: no push, PR or publish. Single test:
  `pnpm exec vitest run <path>` from the worktree root.

## Review Focus

1. **Platform key exfiltration.** An org with a copy that changed the endpoint but left a required
   secret empty can never make the extension see the platform's secret: the save is refused (400
   `extension.config_invalid` naming the secret), and an effective-config read of a copy never falls
   back to platform secrets even for a non-required secret. Tests in Task 5 and Task 6.
2. **A plugin upgrade changes levels.** A field that stops being `override` is ignored in existing
   copies (the org follows the platform for it); a field that becomes `override` is absent from old
   copies (follows the platform); a copy invalid against the new schema makes the org `needsConfig`,
   other orgs unaffected. Tests in Task 5.
3. **Following orgs and an empty platform key.** The platform saves Bailian-like config with the
   required overridable key empty: the extension loads, `ctx.config` lacks the key, the admin view
   says how many orgs need config, following orgs are `needsConfig` and their tools are unavailable,
   an org with a copy works. Tests in Task 4 and Task 7.
4. **Policy hooks while `needsConfig`.** A policy hook of an extension whose effective config is
   invalid in the org denies there (fail closed), and is unaffected in other orgs; an observe hook is
   skipped. Tests in Task 7.
5. **Scope round trip.** An org that turned an `all` item off stays off after the super admin moves
   it to `optional` and back to `all`; a new org gets it on; turning off a dependency an on plugin
   needs is refused with the dependents. Tests in Task 2.

---

### Task 1: SDK `orgAccess()` and `x-org`; packer and check

**Files:**
- Create: `packages/plugin-sdk/src/org-access.ts`
- Modify: `packages/plugin-sdk/src/index.ts` (export), `packages/plugin-sdk/src/config-ui.ts:158-187`
  (`configJsonSchema` override callback, next to `x-secret` / `x-hot`), `config-ui.ts:358`
  (`validateConfigUi` rules), `packages/plugin-sdk/api/plugin-sdk.api.md` (regenerated)
- Create: `packages/plugin-tools/src/check/org-override.ts`; Modify: `packages/plugin-tools/src/check/run.ts:61`
- Test: `packages/plugin-sdk/test/org-access.test.ts`, `packages/plugin-sdk/test/config-ui.test.ts`,
  `packages/plugin-tools/test/pack.test.ts`, `packages/plugin-tools/test/check/org-override.test.ts`
  (+ red fixture `packages/plugin-tools/test/fixtures/org-override-unbound/`)
- Changesets: `.changeset/org-access-sdk.md` (`@capybara-hq/plugin-sdk` minor),
  `.changeset/org-override-check.md` (`@capybara-hq/plugin-tools` minor)

**Interfaces — produces:**
- `export type OrgAccess = "readonly" | "override";`
- `export function orgAccess<T extends z.ZodTypeAny>(schema: T, access: OrgAccess): T` (merges meta
  `{ org: access }`, like `secret()` in `secret.ts:7`)
- `export function orgAccessOf(schema: z.ZodTypeAny): OrgAccess | undefined`
- `configJsonSchema` emits `"x-org": "readonly" | "override"` on the property and removes `org`.
- `validateConfigUi(schema, level)` problems (`{ path, message }`): `x-org` at an org or connection
  level; `x-org` on a non-root node; an unknown value; `x-org: "readonly"` with `x-secret`.
- Plugin check rule `plugin-org-override-unbound` (warning, not error): an extension whose
  deployment schema has an `override` field, that registers no tool, no `ctx.ui` view/action, no hook
  and provides none of `web-search`, `web-fetch`, `directory`, `model-provider`, `file-preview`.

- [ ] **Step 1: Write the failing tests.** `org-access.test.ts`: `orgAccessOf(orgAccess(z.string(),
  "override")) === "override"`; `orgAccessOf(z.string()) === undefined`; `orgAccess(secret(z.string()),
  "override")` keeps `isSecret === true`. `config-ui.test.ts`: `configJsonSchema(z.object({ k:
  orgAccess(secret(z.string()), "override"), h: z.string() })).properties.k["x-org"] === "override"`
  and `properties.h["x-org"] === undefined` and no `org` key anywhere; `validateConfigUi` returns one
  problem each for `{ x-org: "readonly", x-secret: true }` at root (path `["k"]`), for `x-org` nested
  under an object property, for `x-org: "bogus"`, and for any `x-org` with level `"org"`; none for a
  valid deployment schema. `pack.test.ts`: a fixture with an `override` field packs with `x-org` in
  `plugin.json` `extension.configSchemas.deployment` and the static `configFields` entry unchanged
  (`{ path, secret, hot }` only). `org-override.test.ts`: the red fixture reports
  `plugin-org-override-unbound` as a warning; the same fixture plus one `ctx.tools.register` reports
  nothing.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/org-access.test.ts packages/plugin-sdk/test/config-ui.test.ts packages/plugin-tools/test/pack.test.ts packages/plugin-tools/test/check/org-override.test.ts`;
  expected FAIL (`orgAccess` not exported).
- [ ] **Step 3: Implement** the helper, the `x-org` emission, the validation rules and the check
  (scan with the scanner `check/plugin-permissions.ts` uses: `provides` at :162, tools, hooks, ui).
  TSDoc on `orgAccess` states the author's promise (A §5.2): an `override` field is read from the
  per-call `config`, not `ctx.config`, and may be absent from `ctx.config` (A §5.4a).
- [ ] **Step 4: Run** the tests again, then `pnpm gen:sdk-api` and `pnpm check:sdk-api`; expected PASS.
- [ ] **Step 5: Commit** `feat(sdk): orgAccess field levels for deployment config`.

### Task 2: Scope `all` switchable by orgs (kernel)

**Files:**
- Modify: `packages/kernel/src/catalog/scope.ts:30-55` (`wantedOn`, `switchable`),
  `packages/kernel/src/extensions/plugin-items.ts:50` (`itemLocked`),
  `packages/kernel/src/catalog/component-state.ts:98` (`componentLocked`),
  `packages/kernel/src/catalog/owned-items.ts:515-535,726` (review own-scope `all` as "everyone"),
  `packages/kernel/src/extensions/admin-view.ts:405`, `packages/kernel/src/catalog/catalog.service.ts:617`
  (admin list: `offCount`), `packages/kernel/src/catalog/platform-components.ts` (same for components),
  `packages/kernel/src/catalog/scope-sync.ts:20-48` (doc comment)
- Test: flip `packages/kernel/test/catalog/scope.test.ts`, `component-state.test.ts`, `org.test.ts`
  (:1165, :1218), `component-scope.test.ts` (:193, :204), `scope-sync.test.ts` (:387),
  `packages/kernel/test/extensions/org-config.http.test.ts` (:340, :373); add cases to
  `scope-sync.test.ts` and `org.test.ts`

**Interfaces — produces:**
- `wantedOn(item, inList, sw)`: `builtin → true`; `all → sw !== false`; `optional`, `named` unchanged.
- `switchable(item) = !item.builtin`; `itemLocked(i) = i.builtin`; `componentLocked(c, p)` true only
  when the plugin is builtin (own-scope `all` is switchable).
- Admin rows gain `offCount: number` (orgs with a switch row `enabled = false` for an `all` item or
  component; `0` for other scopes).

- [ ] **Step 1: Write the failing tests.** `scope.test.ts` `it.each`: `["all", builtin false, sw
  false] → false`, `["all", false, null] → true`, `["all", builtin true, sw false] → true`,
  `switchable({ scope: "all", builtin: false }) === true`. `org.test.ts` (with `startOrgEnv()`):
  an org admin switches an `all` plugin off (200, extension disabled in the org,
  `enabledExtensionsQuery` lacks it), on again; a builtin one answers 409 `plugin.scope_locked`.
  `scope-sync.test.ts`: org A switched off an `all` item; `setScope(optional)` then `setScope(all)`;
  after the sync A is still off and org B (never switched) is on; a new org created afterwards is on.
  `component-scope.test.ts`: switching off a component of an `all` plugin succeeds, of a builtin
  plugin is 409. A dependency of an on plugin answers 409 with the dependents (existing rule, now for
  `all`). Admin list: `offCount === 1` after A switched off.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog packages/kernel/test/extensions/org-config.http.test.ts`;
  expected FAIL on the new cases.
- [ ] **Step 3: Implement** the four predicate changes and `offCount` (one grouped count query per
  list, not per row). Keep builtin explicit in `wantedOn` (today it maps builtin to `"all"`, R§6).
- [ ] **Step 4: Run** the same command; expected PASS, and `pnpm exec vitest run packages/kernel/test/catalog/scope-sync.dual.test.ts`.
- [ ] **Step 5: Commit** `feat(kernel): orgs may turn off items scoped to all orgs`.

### Task 3: Web for switchable `all`

**Files:**
- Modify: `apps/web/src/app/(app)/extensions/view.tsx:273,300,545`, `apps/web/src/components/PluginSwitch.tsx:49`,
  `apps/web/src/components/ComponentSwitch.tsx:32,97,176`, `apps/web/src/lib/catalog.ts:757-762,1336`,
  `apps/web/src/lib/components.ts:225-229,272`, admin plugin and component list views (scope column),
  `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/catalog-scope.test.tsx`, `workspace-components.test.tsx`, `skills.test.tsx`,
  `admin-components.test.tsx`

**Interfaces — consumes:** Task 2's `switchable`, `locked`, `offCount` fields.

- [ ] **Step 1: Write the failing tests.** An `all` non-builtin row shows a working switch and the
  label 平台默认启用 (en "On by default for all orgs"); a builtin row shows 已启用 · 平台统一 and no
  switch; the admin scope cell reads 全部组织 · 2 个组织已关闭 (en "All orgs · 2 turned off") when
  `offCount = 2`, and 全部组织 when `0`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/catalog-scope.test.tsx apps/web/test/workspace-components.test.tsx apps/web/test/skills.test.tsx apps/web/test/admin-components.test.tsx`; expected FAIL.
- [ ] **Step 3: Implement**: `platform` / `locked` derive from `builtin` (or `required`) only.
- [ ] **Step 4: Run** the same command and `pnpm check:web-ui && pnpm check:i18n`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): switches for items scoped to all orgs`.

### Task 4: Field levels in the kernel, relaxed load gate, platform view

**Files:**
- Create: `packages/kernel/src/extensions/org-levels.ts`
- Modify: `packages/kernel/src/extensions/host.ts:1492-1580` (activation parse), `:2090-2140`
  (`applyDeploymentConfig`), `packages/kernel/src/extensions/deployment-config.ts:69` (field `org`),
  `:352-379` (write validates with the relaxed schema), `:443-504` (`render`: `valid` relaxed,
  `orgMustConfigure`), `packages/kernel/src/extensions/admin-view.ts:416` (state)
- Test: `packages/kernel/test/extensions/org-levels.test.ts` (unit),
  `packages/kernel/test/extensions/deployment-config.test.ts`, kernel fixture
  `packages/kernel/test/fixtures/plugins/orglevels/index.ts` (new: deployment schema `{ host:
  z.string() (hidden), limit: orgAccess(z.number().default(5), "readonly"), baseUrl:
  orgAccess(z.string().url(), "override"), apiKey: orgAccess(secret(z.string()), "override") }`,
  org schema `{ team: z.string().optional() }`, registers one tool `echo` returning `ctx`'s per-call
  config keys, provides `web-search` returning the per-call config)

**Interfaces — produces:**
- `export type FieldLevel = "hidden" | "readonly" | "override";`
- `export function fieldLevels(schema: z.ZodTypeAny | undefined): Map<string, FieldLevel>` (top-level
  keys of a `ZodObject` deployment schema; empty map otherwise; reads `orgAccessOf`)
- `export function relaxOverridable(schema: z.ZodTypeAny): z.ZodTypeAny` (same object with every
  `override` key `.optional()`; identity when none)
- `DeploymentConfigField.org?: "readonly" | "override"`; `DeploymentConfigView.orgMustConfigure:
  string[]` (required `override` paths the platform left empty)
- Admin extension state `running` with `orgsNeedingConfig: number` when `orgMustConfigure` is non-empty
  (count of orgs where the extension is on and no valid copy exists; computed in Task 5's service,
  wired here through `EffectiveConfigs.countNeedingConfig(plugin)`, stubbed to `0` until Task 5).

- [ ] **Step 1: Write the failing tests.** Unit: `fieldLevels` of the fixture schema gives `host →
  hidden`, `limit → readonly`, `baseUrl → override`, `apiKey → override`; `relaxOverridable(schema)
  .safeParse({ host: "h" }).success === true` while the original fails. `deployment-config.test.ts`
  (fixture `orglevels`): saving `{ host: "h" }` only succeeds (200), the extension loads (state
  running, not `pending_config`), `GET admin/extensions/orglevels/config` has `valid: true`,
  `orgMustConfigure: ["baseUrl", "apiKey"]`, and `fields` tagged `org: "override"` / `"readonly"` /
  absent; saving without `host` still fails 400 `extension.config_invalid`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/extensions/org-levels.test.ts packages/kernel/test/extensions/deployment-config.test.ts`; expected FAIL.
- [ ] **Step 3: Implement**: parse with `relaxOverridable(schema)` in both host paths and the write
  path; `ctx.config` is the relaxed parse result (override keys may be absent).
- [ ] **Step 4: Run** the same command plus `packages/kernel/test/extensions/deployment-config.dual.test.ts`; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): field levels and a load gate that lets orgs bring overridable values`.

### Task 5: Org copies and the effective config

**Files:**
- Create: `packages/kernel/src/migrations/0086_org_layering.sql`,
  `packages/kernel/src/extensions/org-overrides.ts` (service), `packages/kernel/src/extensions/effective-config.ts`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (two tables), `packages/kernel/src/extensions/extensions.module.ts`
  (providers), `packages/kernel/src/extensions/org-config.ts:45,198,734` (view gains
  `overrideState`, `needsConfig`; `reportSecrets` includes copy secrets for redaction),
  `packages/kernel/src/catalog/org-extension.controller.ts` (routes), `packages/kernel/src/admin/extensions.controller.ts`
  (org copies list), `packages/kernel/src/errors.ts`
- Test: `packages/kernel/test/extensions/org-overrides.http.test.ts` (new, `startKernel` with
  `extensions: [fx("orglevels")]`, `autoApprove: true`, the account helpers of
  `org-config.http.test.ts:25-58`), `packages/kernel/test/extensions/org-overrides-migration.test.ts`

**Interfaces — produces (migration 0086):**
- `extension_org_overrides (plugin text NOT NULL, org_id text NOT NULL REFERENCES orgs(id) ON DELETE
  CASCADE, config jsonb NOT NULL DEFAULT '{}'::jsonb, created_by text REFERENCES accounts(id) ON
  DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_by text REFERENCES
  accounts(id) ON DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (plugin,
  org_id))` — a row is a copy; `config` holds non-secret override values; no row = following.
- `org_tool_switches (org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, plugin text NOT
  NULL, tool text NOT NULL, enabled boolean NOT NULL, updated_by text REFERENCES accounts(id) ON
  DELETE SET NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org_id, plugin, tool))`
  (used by Task 8).

**Interfaces — produces (services):**
- `EffectiveConfigs.get(orgId: string, plugin: string): Promise<EffectiveConfig>` where
  `type EffectiveConfig = { ok: true; config: unknown; source: "platform" | "copy" } | { ok: false;
  issues: ConfigIssue[] }`. Following: the platform's merged deployment config, validated with the
  **full** schema (an empty required override field → `ok: false`). Copy: platform values for
  hidden and readonly fields + the copy's override values (copy keys whose level is no longer
  `override` ignored; override fields missing from the copy taken from the platform **only if
  non-secret**) + copy secrets, validated with the full schema. Cached per (orgId, plugin, platform
  configHash) through `CacheService`, evicted after copy writes.
- `EffectiveConfigs.countNeedingConfig(plugin: string): Promise<number>`.
- `OrgOverrides.view(orgId, plugin): Promise<OrgOverrideView>`:
  `{ state: "following" | "copy"; createdAt?: string; fields: Array<{ path: string; level:
  "readonly" | "override"; secret: boolean; platform: { value?: unknown; set?: boolean }; org?: {
  value?: unknown; set?: boolean }; differs?: boolean }>; valid: boolean; issues: ConfigIssue[] }`
  — hidden fields absent; secrets give `set` only and no `differs`.
- `OrgOverrides.save(orgId, plugin, values: Record<string, unknown>, secretEntries: SecretEntry[],
  actor): Promise<OrgOverrideView>` — first save creates the copy from the platform's non-secret
  override values plus `values`; refuses a `readonly` or hidden path (400
  `extension.field_not_overridable`); refuses an invalid result (400 `extension.config_invalid`,
  issues name an empty required secret). Audit `extension.org_override_saved` with `changedPaths`.
- `OrgOverrides.take(orgId, plugin, paths: string[], actor)` — non-secret override paths only
  (a secret path → 400 `extension.field_not_overridable`); 404 `extension.no_org_override` without a
  copy; audit `extension.org_override_taken`.
- `OrgOverrides.reset(orgId, plugin, actor)` — deletes the row and the org's
  `plugin-override:<plugin>:%` secrets in one transaction; audit `extension.org_override_reset`.
- `OrgOverrides.listForPlugin(plugin): Promise<Array<{ orgId: string; orgName: string; createdAt:
  string; differing: string[]; secrets: Array<{ path: string; set: boolean }> }>>`
- Routes (`org.extensions.manage`, members refused): `GET|PUT|DELETE
  api/v1/orgs/:orgId/extensions/:extension/overrides`, `POST …/overrides/take` (`{ paths }`);
  super admin: `GET api/v1/admin/extensions/:name/org-overrides`.
- `OrgExtensionView` gains `overrideState: "following" | "copy" | "none"` (`none` = no override
  fields) and `needsConfig: boolean` (effective config not ok, or required org-only config missing).
- New error codes: `extension.field_not_overridable` 400, `extension.no_org_override` 404.

- [ ] **Step 1: Write the failing tests.** Migration test: 0085 → 0086 creates both tables; rerun is a
  no-op. HTTP test, platform config `{ host: "h", baseUrl: "https://p.example", apiKey: "pk" }`:
  1. `GET …/overrides` as org admin: `state: "following"`, `baseUrl.platform.value ===
     "https://p.example"`, `apiKey.platform` is `{ set: true }` with no value, no `host` field; as a
     member → 403.
  2. `PUT …/overrides { values: { baseUrl: "https://o.example" } }` without `apiKey` → 400
     `extension.config_invalid` with an issue on `apiKey`; nothing stored.
  3. Same with `secretEntries` for `apiKey: "ok"` → 200, `state: "copy"`; `EffectiveConfigs.get`
     gives `{ host: "h", limit: 5, baseUrl: "https://o.example", apiKey: "ok" }`; another org's
     effective config is the platform's.
  4. The platform changes `baseUrl` to `https://p2.example`: the copy org keeps `o.example`; a
     following org sees `p2.example`; `GET …/overrides` marks `baseUrl.differs === true`.
  5. `POST …/overrides/take { paths: ["baseUrl"] }` → copy has `p2.example`, still `state: "copy"`;
     `take { paths: ["apiKey"] }` → 400 `extension.field_not_overridable`.
  6. `PUT` with `values: { limit: 9 }` → 400 `extension.field_not_overridable`.
  7. `DELETE …/overrides` → `state: "following"`, effective config is the platform's, the org's
     `plugin-override:orglevels:%` secrets are gone, audit rows exist for save, take and reset.
  8. Platform saved with `{ host: "h" }` only: a following org's `GET orgs/:orgId/extensions` row has
     `needsConfig: true`, `EffectiveConfigs.get` is `ok: false`; `countNeedingConfig` counts it;
     after that org saves a full copy it is `needsConfig: false`.
  9. Level change: a second fixture version where `baseUrl` is hidden — an existing copy's
     `baseUrl` is ignored (effective `baseUrl` = platform's), the copy stays valid.
  10. `GET admin/extensions/orglevels/org-overrides` lists the copy org with `differing` and
      `secrets: [{ path: "apiKey", set: true }]`, never a secret value.
  11. `baseUrl` fixed by the startup config (`CAPYBARA_EXTENSION_CONFIG__ORGLEVELS__BASE_URL`): the
      platform form shows it read-only, an org can still save a copy with its own `baseUrl` (A §5.8).
  12. Disabling the extension on the deployment and enabling it again keeps the copy.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/extensions/org-overrides.http.test.ts packages/kernel/test/extensions/org-overrides-migration.test.ts`; expected FAIL.
- [ ] **Step 3: Implement** the migration (comment each table with `0086` and the spec section), the
  Kysely types, the two services (`@Transactional()` writes, cache eviction in `afterCommit`), the
  routes with `createZodDto` bodies, the error codes and the `OrgExtensionView` fields. Secrets
  through `createSecrets(db, keyring, "kernel")` (`ctx/secrets.ts:142`) with the org id. Wire
  `countNeedingConfig` into Task 4's admin state.
- [ ] **Step 4: Run** the same command plus `packages/kernel/test/extensions/org-config.http.test.ts`; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): org copies of overridable config and the effective config`.

### Task 6: Effective config in every org-bound call (SDK types + kernel call sites)

**Files:**
- Modify (SDK, additive optional fields): `packages/plugin-sdk/src/web.ts:19-61` (`search` / `fetch`
  args and `configured?(orgConfig, config?)`), `directory.ts:21-26`, `tool.ts:175`
  (`ToolCallContext.config?: unknown`), `ui.ts:386` (`UiRenderArgs.config?`), `file-preview.ts:37`
  (`FilePreviewArgs.config?`), `hooks.ts:187` (`HookHandler = (payload, signal, call?: { config:
  unknown }) => …`); API snapshot.
- Modify (kernel): `extensions/point-defaults.ts:151-199` (exclude when `EffectiveConfigs.get` is not
  ok; `PointResolution` gains `config`), `tools/builtins/web/search.ts:228-235`, `fetch.ts:131-142`,
  `orgs/directory-sync.ts:229-260,480`, `tools/pipeline.ts:1109-1140`, `ui/views.ts:283-360`,
  `files/previewers.ts:274-310`, `extensions/hooks.ts:254-262,515` (and `runtime/usage-report.ts`)
- Test: `packages/kernel/test/tools/web-search.test.ts`, `test/orgs/directory-sync.test.ts`,
  `test/tools/pipeline.test.ts`, `test/ui/views.http.test.ts`, `test/files/previewers.http.test.ts`,
  `test/extensions/hooks.test.ts`; the fixtures they load (`fake-web`, `dir-mini`, `tools-probe`,
  `hooks-probe`, the ui and preview fixtures) gain an `override` field and echo the per-call config
- Changeset: add to `.changeset/org-access-sdk.md`

**Interfaces — consumes:** `EffectiveConfigs.get` (Task 5). **Produces:** the field `config` (the
effective config) on every listed call; nothing else changes for extensions without override fields
(their effective config equals `ctx.config`).

- [ ] **Step 1: Write the failing tests**, one per call site, each with two orgs (A following, B with
  a copy whose override field is `"org-b"`): the call made for B receives `config.<field> ===
  "org-b"`, for A the platform value. Plus: web-search point resolution skips a provider whose
  effective config is not ok in the org (the tool reports the point as unconfigured); directory sync
  skips the org; a tool call in a `needsConfig` org is not dispatched; `hooks.test.ts`: a `policy`
  hook of an extension `needsConfig` in org A denies a model request there (`hook_denied` event) and
  is called in org B; an `observe` hook is not called in A.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/tools/web-search.test.ts packages/kernel/test/orgs/directory-sync.test.ts packages/kernel/test/tools/pipeline.test.ts packages/kernel/test/ui/views.http.test.ts packages/kernel/test/files/previewers.http.test.ts packages/kernel/test/extensions/hooks.test.ts`; expected FAIL.
- [ ] **Step 3: Implement**: one `EffectiveConfigs.get` per call site per call (the cache makes it
  cheap); a not-ok result means "do not call" with the per-site behaviour of A §6.
- [ ] **Step 4: Run** the same command, then `pnpm gen:sdk-api`, `pnpm check:sdk-api`, and the
  zero-drift fixtures `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/evals/rename-compat.test.ts`; expected PASS.
- [ ] **Step 5: Commit** `feat: org-bound extension calls carry the org's effective config`.

### Task 7: Tools of a `needsConfig` extension

**Files:**
- Modify: `packages/kernel/src/tools/registry.ts:580-604` (`resolve` plugin branch)
- Test: `packages/kernel/test/tools/registry.test.ts`

**Interfaces — produces:** `UnavailableTool.reason` `"Plugin ${p} needs configuration in this
organization"` when `EffectiveConfigs.get` is not ok for the org.

- [ ] **Step 1: Write the failing test**: fixture `orglevels` with the platform key empty: an agent
  in a following org that selected `echo` gets it in `unavailable` with that reason and not in
  `tools`; the same agent in an org with a valid copy gets it in `tools`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/tools/registry.test.ts`; expected FAIL.
- [ ] **Step 3: Implement** the check after the enabled check (:587-592).
- [ ] **Step 4: Run** the same command; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): extension tools are unavailable where the org must configure`.

### Task 8: Per-org tool switches (kernel)

**Files:**
- Create: `packages/kernel/src/tools/org-tool-switches.ts`
- Modify: `packages/kernel/src/tools/registry.ts:580-604`, `packages/kernel/src/tools/pipeline.ts:1120`
  (refusal at execution), `packages/kernel/src/tools/info.ts:252-259` (`OrgExtensionTools.list` marks
  `switchedOff`), `packages/kernel/src/catalog/org-extension.controller.ts` (routes), tools module
- Test: `packages/kernel/test/tools/org-tool-switches.http.test.ts` (new), `registry.test.ts`,
  `pipeline.test.ts`, `extension-tools.http.test.ts`

**Interfaces — produces:**
- `OrgToolSwitches.list(orgId, plugin): Promise<Array<{ tool: string; enabled: boolean }>>` (every
  tool the extension registers on this replica, default enabled)
- `OrgToolSwitches.set(orgId, plugin, tool, enabled: boolean, actor, confirm?: string):
  Promise<{ applied: false; affectedAgents: Array<{ id: string; name: string }>; confirm: string } |
  { applied: true }>` — switching off without `confirm` returns the PCM §5 rule 8 preview (agents of
  the org whose current version selects the tool) and a hash; with the matching hash applies;
  switching on applies at once. Audit `extension.tool_switched`.
- `isToolOff(orgId, plugin, tool): Promise<boolean>` used by the registry and the pipeline.
- Routes: `GET api/v1/orgs/:orgId/extensions/:extension/tools` (`org.extensions.read`),
  `PUT …/tools/:tool` `{ enabled, confirm? }` (`org.extensions.manage`); 404 for a tool the
  extension does not register.
- Unavailable reason: `"Tool ${name} is turned off in this organization"`; execution of a stale call
  returns the tool error "Tool … is turned off in this organization." (model-visible, English).

- [ ] **Step 1: Write the failing tests.** HTTP: switch `tools-probe`'s tool off without confirm →
  `applied: false` listing an agent that selected it; with the hash → `applied: true`; a member's PUT
  → 403; the editor list (`GET …/tools/extensions`) marks it `switchedOff: true`. Registry: the agent
  gets it in `unavailable` with the reason; another org still has it. Pipeline: a call to it
  (resumed step) returns the turned-off error and does not run the handler. Switch on → available.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/tools/org-tool-switches.http.test.ts packages/kernel/test/tools/registry.test.ts packages/kernel/test/tools/pipeline.test.ts packages/kernel/test/tools/extension-tools.http.test.ts`; expected FAIL.
- [ ] **Step 3: Implement** (table from Task 5's migration).
- [ ] **Step 4: Run** the same command and the zero-drift fixtures of Task 6 Step 4; expected PASS.
- [ ] **Step 5: Commit** `feat(kernel): org admins turn off single extension tools`.

### Task 9: Web, two-level config forms

**Files:**
- Modify: `apps/web/src/components/config-form/model.ts:195` (`FieldMeta.platform?: { value?:
  unknown; set?: boolean }`, `FieldMeta.level?: "readonly" | "override"`), `config-form/deployment.ts:67`
  (level tags from `view.fields[].org`), `config-form/org.ts` (adapter for `OrgOverrideView`),
  `components/OrgExtensionSheet.tsx`, `components/ExtensionDeploymentConfig.tsx`,
  `app/(app)/admin/extensions/[name]/view.tsx` (org copies list, 组织需各自配置 state),
  `lib/extensions.ts`, `lib/query/keys.ts`, `lib/query/channels.ts` / `lib/query/admin.ts` (queries
  and invalidations), `apps/web/messages/{zh,en}.json`
- Create: `apps/web/src/components/OrgOverrideDiff.tsx` (compare and take, built from design
  components)
- Test: `apps/web/test/config-form-adapters.test.ts`, `apps/web/test/org-overrides.test.tsx` (new),
  `apps/web/test/admin-extensions.test.tsx`

**Interfaces — consumes:** Task 4 (`org`, `orgMustConfigure`, `orgsNeedingConfig`), Task 5 routes and
views. Keys: `keys.org(o).orgExtensionOverrides(name)`, `keys.admin().extensionOrgOverrides(name)`.

Copy (zh / en): 平台配置 / Set by the platform; 跟随平台 / Following the platform; 本组织使用自己的配置
/ This org uses its own configuration; 与平台对比 / Compare with the platform; 采用平台值 / Use the
platform value; 使用平台配置 / Use the platform configuration; confirm text 将删除本组织自己的配置（包括密钥），之后跟随平台的配置。
/ This org's own configuration, keys included, will be deleted, and the org will follow the platform
again.; first-edit notice 修改后本组织将使用自己的配置，需要填写自己的密钥。 / After this change the
org uses its own configuration and needs its own keys.; secret states 平台已配置 / 本组织已配置 / 未配置;
level tags 组织不可见 / 组织只读 / 组织可覆盖 (en Hidden from orgs / Read-only for orgs / Orgs can
override); admin state 运行中 · 组织需各自配置 / Running · orgs configure their own.

- [ ] **Step 1: Write the failing tests.** Adapter: an `OrgOverrideView` builds a form whose
  `readonly` fields are disabled with 平台配置 and whose secret fields show 平台已配置 without a value.
  Sheet: while following, the first edit shows the first-edit notice and the empty secret fields are
  required in the same save; with a copy, the banner shows 与平台对比 and 使用平台配置; the confirm
  dialog shows the confirm text and calls `DELETE …/overrides`; the diff lists differing non-secret
  fields with 采用平台值 and secret rows with configured states only. Admin: the config tab shows the
  level tags; the detail lists org copies; the state reads 运行中 · 组织需各自配置 with the count.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/config-form-adapters.test.ts apps/web/test/org-overrides.test.tsx apps/web/test/admin-extensions.test.tsx`; expected FAIL.
- [ ] **Step 3: Implement**. If no design component fits the diff rows, follow the design change flow
  of `writing-web-ui` first (component in `packages/design`, reference state, `/dev/ui`).
- [ ] **Step 4: Run** the same command and `pnpm check:web-ui && pnpm check:i18n`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): two-level extension config forms`.

### Task 10: Web, tool switches

**Files:**
- Modify: `apps/web/src/components/OrgExtensionSheet.tsx` (tools list with switches for org admins,
  read-only for members), `apps/web/src/lib/extensions.ts`, `lib/query/keys.ts`
  (`keys.org(o).extensionToolSwitches(name)`), `components/agent/ToolsSection.tsx` and
  `components/agent-template/EditSections.tsx:412,534` (switched-off reason),
  `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/org-tool-switches.test.tsx` (new), `apps/web/test/agent-extension-tools.test.tsx`

Copy: 已在本组织关闭 / Turned off in this org; preview dialog 以下智能体正在使用这个工具，关闭后它们将无法使用： /
These agents use this tool and will lose it:.

- [ ] **Step 1: Write the failing tests**: turning a tool off shows the preview dialog with the agents
  from `applied: false`, confirming sends the hash; the agent editor shows the tool as 已在本组织关闭.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/org-tool-switches.test.tsx apps/web/test/agent-extension-tools.test.tsx`; expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command and `pnpm check:web-ui && pnpm check:i18n`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): org switches for single extension tools`.

### Task 11: Docs, changesets, verify

**Files:** `AGENTS.md` (Config bullet :83-85; scope `all` in "Plugins and the catalog" :104; a line
on effective config under "Extensions"), `.agents/skills/writing-extensions/SKILL.md` ("Two-level
config" :131-156: levels, `orgAccess`, copies, effective config, `needsConfig`, hooks fail closed),
`.agents/skills/writing-plugins/SKILL.md:164,224-228` (`all` switchable), `.agents/skills/writing-tools/SKILL.md`
(org tool switches), the spec's status line (implemented, migration 0086), `.changeset/org-layering-kernel.md`
(`@capybara-hq/kernel` minor, `@capybara-hq/web` minor). The plugins repository's
`writing-extensions` copy is updated in a separate plugins PR after release (note it in the PR body).

- [ ] **Step 1:** Update the docs; keep `check:skills-frontmatter` and `check:terms` green.
- [ ] **Step 2:** Run `pnpm -s verify --json`; expected every check passes (lint, typecheck, check,
  the affected tests).
- [ ] **Step 3: Commit** `docs: platform and org layering`.
