# Unified Plugin Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository, execute with the `wave-planned-subagent-development` skill using the wave plan at the end.

**Goal:** Every plugin's deployment config is org-overridable by default, platform-only by an explicit
`platformOnly` mark; `config.org` and the `readonly` level are gone; overridable URLs reach the network
only through `configUrlFetch` / `ctx.net`; only object-store-s3, skills-core and file-preview are fixed
builtins.

**Architecture:** The SDK swaps `orgAccess` for `platformOnly` and adds `configUrlFetch`; the kernel's
level logic flips its default and drops the org-only config layer (enablement stays); plugin-tools
checks enforce the classification; the plugins repository applies the per-field table of the spec.
Three phases: core PR → SDK / plugin-tools release → plugins PR → plugins release → core bootstrap
re-pin.

**Tech Stack:** TypeScript, zod 4, NestJS kernel, Next web app, vitest, oxc (checks), pnpm.

**Spec:** `docs/superpowers/specs/2026-11-23-unified-plugin-config-design.md` (read §5 and §6 before
any task; spec A `docs/superpowers/specs/2026-11-07-platform-org-layering-design.md` §5–§6 for what
stays).

## Global Constraints

- No compatibility layers or aliases for `orgAccess`, `orgAccessOf`, `OrgAccess`, `x-org`,
  `config.org`, `orgConfig`, `readonly` or `config.org:*` permission keys (pre-0.1.0).
- Levels sit on top-level deployment keys only; `platformOnly` is allowed on the root schema or a
  top-level property, nowhere else.
- JSON Schema marker: `"x-platform-only": true` (exactly this key and value).
- Platform secrets never enter an org copy; platform-only secrets stay in the effective config (spec A
  §5.4 unchanged).
- English for code comments, test titles you touch, docs, commits (`pnpm check:english-comments --base origin/main`).
- UI copy through i18n in zh and en; zh uses 平台 / 超级管理员 / 智能体, never 企业 or Latin `agent`.
- Level tag copy: zh `组织可覆盖` / `仅平台`, en `Org can override` / `Platform only`.
- Run single tests from the repo root: `pnpm exec vitest run <path>`.
- No fixed sleeps, no per-test timeouts; new unit or container tests join their checked-in list.
- No migration in this change (the `extension_org_configs.config` drop is a later contract step).
- SDK public API change: `pnpm gen:sdk-api` + changeset bumping `@capybara-hq/plugin-sdk`.
- Conventional Commits, body lines ≤ 100 chars, ending with
  `Co-Authored-By: Capybara <noreply@capybarahq.com>`.
- Do not move `bootstrap.json`'s `marketplace.commit` or any pin while another session's restage
  window is open (ask the main session before Task 6 and Task 17).

## Review Focus

1. **Hot change of the platform URL after an org saved a copy with the old value:** the org's value no
   longer equals the platform's, so it goes through `ctx.net` (an internal host is then refused with an
   actionable error, never silently sent with the global fetch). Pinned in Task 2.
2. **URL equality edge cases:** `https://h/v1/` equals `https://h/v1`; `https://h/v1` does not equal
   `https://h/v1/x` or `http://h/v1`; an undefined platform value never matches. Pinned in Task 2.
3. **Platform leaves a formerly platform-only required field empty** (anthropic `apiKey`): the extension
   loads, setup does not throw, following orgs are `needsConfig` and get no call. Pinned in Tasks 4 and 11.
4. **An org endpoint must not poison another org's cache** (anthropic `ctx.kv` model cache). Pinned in
   Task 11.
5. **openai-compatible copy keeping a platform endpoint plus adding its own private one:** the kept one
   uses the global fetch, the added one is refused through `ctx.net`. Pinned in Task 13.

---

## Phase 1: core (one PR, `feat/720-unified-plugin-config`)

### Task 1: SDK config marks and config shape

**Files:**
- Delete: `packages/plugin-sdk/src/org-access.ts`, `packages/plugin-sdk/test/org-access.test.ts`
- Create: `packages/plugin-sdk/src/platform-only.ts`, `packages/plugin-sdk/test/platform-only.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts` (export swap), `src/config-ui.ts:160-190,380-420`
  (publish and validate the marker), `src/define-extension.ts:36`, `src/plugin-package.ts:197`,
  `src/plugin-manifest.ts:597` (and the `config` shape of the static manifest schema), `src/web.ts`,
  `src/directory.ts`, `test/config-ui.test.ts`, `test/plugin-package.test.ts`,
  `packages/plugin-sdk/agent-docs/` (the topic that explains extension config),
  `packages/plugin-sdk/api/plugin-sdk.api.md` (regenerated), `.changeset/*.md` (new)

**Interfaces:**
- Produces: `platformOnly<T extends z.ZodTypeAny>(schema: T): T` (meta `{ platformOnly: true }`, merged
  with existing meta like `secret()`); `isPlatformOnly(schema: z.ZodTypeAny): boolean` (sees through
  `default`, `prefault`, `optional`, `nullable`, `readonly`, `catch`; outermost wins).
- Produces: `ExtensionManifest.config?: { deployment?: z.ZodTypeAny }`; static manifest
  `config: { deployment: ConfigField[] }`.
- Produces: `WebSearchProvider.configured?(config: unknown): boolean`, `search(args: { config: unknown; … })`
  without `orgConfig`; same for `WebFetchProvider`; `Directory.configured?(config: unknown): boolean`,
  `listMembers(args: { config: unknown; cursor?: string; signal: AbortSignal })`.

- [ ] **Step 1: Write failing tests** in `test/platform-only.test.ts`:
  `platformOnly(z.string())` → `isPlatformOnly` true; `secret(platformOnly(x))` and `platformOnly(secret(x))`
  both keep `isSecret` and `isPlatformOnly` true; `isPlatformOnly(platformOnly(x).optional().default("a"))`
  true; `isPlatformOnly(z.string())` false. In `test/config-ui.test.ts`: `configJsonSchema(z.object({ a:
  platformOnly(z.string()) }))` gives `properties.a["x-platform-only"] === true` and no `"x-org"`;
  `configJsonSchema(platformOnly(z.object({ a: z.string() })))["x-platform-only"] === true`;
  `validateConfigUi` reports for the marker on a nested field (depth 2), on an `org` or `connection`
  level schema, and for a value other than `true`. In `test/plugin-package.test.ts`: the static manifest
  has no `config.org` and a manifest JSON carrying `config.org` is rejected.
- [ ] **Step 2:** `pnpm exec vitest run packages/plugin-sdk/test/platform-only.test.ts packages/plugin-sdk/test/config-ui.test.ts packages/plugin-sdk/test/plugin-package.test.ts` → FAIL (module not found / assertions).
- [ ] **Step 3:** Implement `platform-only.ts`; in `config-ui.ts` map meta `platformOnly` to
  `"x-platform-only": true` (replacing the `org` → `x-org` mapping) and replace the `x-org` validation
  with: allowed only at level `deployment`, depth 0 or 1, value `true`. Drop `org` from
  `defineExtension`, the static manifest, `staticManifestOf`, and the duplicate-path loop. Drop
  `orgConfig` from `web.ts` / `directory.ts` and make `config` required; rewrite their TSDoc (effective
  config = platform deployment config with the org's copy applied to overridable fields). Rewrite the
  TSDoc of `platformOnly` with the hidden-secret rule from spec §5.1 (never send a platform-only secret
  to an endpoint taken from an overridable field).
- [ ] **Step 4:** Re-run Step 2 → PASS; `pnpm --filter @capybara-hq/plugin-sdk typecheck` (or `pnpm typecheck`
  scoped) → errors only outside the SDK (kernel / testing; fixed in later tasks).
- [ ] **Step 5:** `pnpm gen:sdk-api`; `pnpm gen:agent-docs`; edit the config topic by hand; add a changeset
  bumping `@capybara-hq/plugin-sdk` (minor-in-prerelease as the repo does: copy the bump kind of the
  latest SDK changeset in `.changeset/` history).
- [ ] **Step 6: Commit** `feat(plugin-sdk): replace orgAccess with platformOnly and drop config.org`

### Task 2: SDK `configUrlFetch`

**Files:**
- Create: `packages/plugin-sdk/src/config-url-fetch.ts`, `packages/plugin-sdk/test/config-url-fetch.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`, `packages/plugin-sdk/api/plugin-sdk.api.md`, the Task 1 changeset

**Interfaces:**
- Consumes: `ExtensionNet` (`src/net.ts:48`).
- Produces: `configUrlFetch(net: Pick<ExtensionNet, "fetch">, opts: { url: string; platform?: string | readonly string[] | undefined; orgId?: string | undefined }): typeof fetch`.

- [ ] **Step 1: Failing tests** (`config-url-fetch.test.ts`, fake `net.fetch` recording calls, global
  fetch stubbed with `vi.stubGlobal`): returns the global fetch when `url === platform`; when they differ
  only by trailing slashes (`https://h/v1/` vs `https://h/v1`); when `platform` is a list containing it.
  Returns a function that calls `net.fetch(input, init, { orgId: "o1" })` when `url` is
  `https://h/v1/x`, `http://h/v1`, or `platform` is undefined. With `orgId` undefined the net call gets
  `{}` / no orgId. Review Focus 1: a caller passing the current `ctx.config` value as `platform` after it
  changed gets the net fetch for the old org value.
- [ ] **Step 2:** `pnpm exec vitest run packages/plugin-sdk/test/config-url-fetch.test.ts` → FAIL.
- [ ] **Step 3:** Implement; normalisation = strip trailing `/` only (as deepseek's `sameUrl`). TSDoc:
  the caller reads `platform` from `ctx.config` at call time; vendor SDKs take the result as their
  `fetch` option.
- [ ] **Step 4:** Re-run → PASS; `pnpm gen:sdk-api`.
- [ ] **Step 5: Commit** `feat(plugin-sdk): add configUrlFetch for overridable URLs`

### Task 3: plugin-tools checks `plugin-config-unbound` and `plugin-org-url-net`

**Files:**
- Delete: `packages/plugin-tools/src/check/org-override.ts`, `test/check/org-override.test.ts`,
  `test/fixtures/org-override-unbound/`
- Create: `packages/plugin-tools/src/check/config-classification.ts`,
  `test/check/config-classification.test.ts`, fixtures `test/fixtures/config-unbound/` (red: tools-less
  extension providing only `channel@1` with an unmarked field), `test/fixtures/config-bound-clean/`
  (green: same with root `platformOnly`), `test/fixtures/org-url-unrouted/` (red: overridable
  `baseUrl: z.url()` fetched with global `fetch`), `test/fixtures/org-url-named/` (red: overridable
  `apiEndpoint: z.string()` without `format: "uri"`), `test/fixtures/org-url-routed/` (green:
  `configUrlFetch(ctx.net, { url: config.baseUrl, platform, orgId })`, plus a nested
  `endpoints[].baseUrl` routed via a destructured `baseUrl`)
- Modify: `src/check/index.ts:14`, `src/check/run.ts:5,69`, `src/pack/pack.ts:714` (no `schemas.org`),
  `src/pack/config-schemas.ts` (deployment only), `test/pack.test.ts:511` and fixture
  `test/fixtures/org-override-pack/` (rename to `platform-only-pack`, assert `x-platform-only` in the
  packed `plugin.json`), `tools/checks/README.md` (a line for each rule under plugin-tools checks),
  `.changeset/*.md` (bump `@capybara-hq/plugin-tools`)

**Interfaces:**
- Consumes: Task 1 (`x-platform-only`), Task 2 (`configUrlFetch` name), `findCtxCalls` (`check/plugin-permissions.ts`).
- Produces: `checkConfigClassification(pluginDirs: string[]): Promise<Finding[]>`, rules
  `plugin-config-unbound` and `plugin-org-url-net`, severity `error`; run entry name "Config classification".

- [ ] **Step 1: Failing tests:** red fixtures yield exactly one finding each with the rule names above,
  pointing at `src/index.ts` (unbound) or the field's declaring file and line (url rules); the
  `config-unbound` message names the field and says `platformOnly`; green fixtures yield none; an
  extension with root `platformOnly` that also registers tools yields none (Review Focus 5 in spirit:
  no false positive on marked roots).
- [ ] **Step 2:** `pnpm exec vitest run packages/plugin-tools/test/check/config-classification.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Overridable = top-level key without `x-platform-only` and root without it.
  Org-bound = registers a tool, `ctx.ui` view/action or hook (`findCtxCalls`), or provides one of
  `model-provider`, `web-search`, `web-fetch`, `directory`, `file-preview`. URL fields = any node with
  `format: "uri"` under an overridable key (properties, items, recursively); leaf name = last property
  name. Routed = a `configUrlFetch(` call (imported from `@capybara-hq/plugin-sdk`) whose second
  argument's `url` property expression contains the leaf as a member name, string-literal key, or
  identifier (oxc AST, as `findCtxCalls`). Named-URL rule: overridable string key matching
  `/(url|uri|endpoint|host)$/i` without `format: "uri"`. Document the known gaps of spec §5.5 in the
  function's TSDoc.
- [ ] **Step 4:** Re-run → PASS; `pnpm exec vitest run packages/plugin-tools/test/pack.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(plugin-tools): check config classification and org URL routing`

### Task 4: kernel levels (`platform` / `override`)

Risk high (decides what orgs see and which secrets enter copies).

**Files:**
- Modify: `packages/kernel/src/extensions/org-levels.ts`, `src/extensions/deployment-config.ts:90-100`,
  `src/extensions/org-overrides.ts` (drop `readonly`), `src/extensions/effective-config.ts` (comment at
  `:35` and any `readonly` path), `plugins/model-fake/src/index.ts:6,19` (drop `orgAccess`)
- Modify tests/fixtures: `packages/kernel/test/extensions/org-levels.test.ts`,
  `org-levels-schemas.test.ts`, `org-overrides.http.test.ts`, `org-bound-calls.http.test.ts`,
  `config-ui-load.test.ts`, fixtures `packages/kernel/test/fixtures/plugins/{orglevels,orglevels-v2,orgrefined,orgwrapped,orgcalls,model-org-key,model-copy-fail,route-access}/index.ts`

**Interfaces:**
- Consumes: Task 1 (`isPlatformOnly`, `x-platform-only`).
- Produces: `type FieldLevel = "platform" | "override"`; `fieldLevels(schema)` → every top-level key
  `override` unless the key or the root is platform-only; `jsonSchemaFieldLevels(schema)` same from
  `x-platform-only`; `DeploymentConfigField.level: FieldLevel` replacing `org?`; `OrgOverrideField`
  without `level` (all listed fields are overridable).

- [ ] **Step 1: Failing tests** in `org-levels.test.ts`: unmarked key → `override`; `platformOnly` key →
  `platform`; root `platformOnly` → all `platform`; `missingOverridable` lists an unmarked required key
  absent from the platform config; `parseLoadGate` accepts `{}` for `{ apiKey: secret(z.string()) }`
  (Review Focus 3) and refuses `{}` for `{ host: platformOnly(z.string()) }`. In
  `org-overrides.http.test.ts`: the org view lists no platform-only field and has no `level`; writing a
  platform-only path → `extension.field_not_overridable`; a first copy still refuses an empty required
  secret (unchanged rule, now on a default-overridable field). Delete every `readonly` case.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/extensions/org-levels.test.ts packages/kernel/test/extensions/org-overrides.http.test.ts` → FAIL.
- [ ] **Step 3:** Implement the level flip and the type changes; rewrite the fixtures to use
  `platformOnly` where they relied on "no level = hidden" and drop `orgAccess`.
- [ ] **Step 4:** Re-run Step 2 plus the other files listed above → PASS.
- [ ] **Step 5: Commit** `feat(kernel): deployment config fields are org-overridable by default`

### Task 5: kernel drops `config.org`

Risk high (cross-tenant: org config reads, directory sync, web providers).

**Files:**
- Modify: `packages/kernel/src/extensions/org-config.ts` (enablement only: remove `secretKey`,
  config/secrets read-write, `decode`, `setSecretKeys`, the org-schema validation, `OrgConfigInvalidError`
  if only used there; `OrgExtensionView` loses `config`, `secrets`, `orgConfigSchema`),
  `src/catalog/org-extension.schemas.ts:20-28` (`OrgExtensionPut` loses `config`),
  `src/catalog/org-extension.controller.ts:78,128`, `src/catalog/plugin-install.ts:1267`,
  `src/catalog/org-catalog.service.ts:267`, `src/catalog/scope-sync.ts:496`,
  `src/extensions/point-defaults.ts`, `src/orgs/directory-sync.ts`,
  `src/tools/builtins/web/search.ts:230`, `src/tools/builtins/web/fetch.ts:140`,
  `src/setup/setup-checks.service.ts:872`, `src/extensions/permission-set.ts:154`,
  `src/agents/readiness.service.ts:42`, `src/errors.ts` (remove `extension.no_org_config`),
  `src/platform/ops/extensions.ops.ts:312-395`, `src/platform/ops/org-plugins.ops.ts:249`,
  `src/platform/ops/plugins.ops.ts:95-118`, `src/platform/route-schemas.ts` if it lists the changed body
- Modify fixtures: `packages/testing/fixtures/extensions/{fake-web,fake-web-2,fake-im,fake-context}/src/*.ts`
  (org fields move into `deployment`; directory/web fixtures read `config`),
  `packages/kernel/test/fixtures/plugins/dir-opt/index.ts`
- Modify tests: `packages/kernel/test/extensions/{org-config.test.ts,org-config.http.test.ts,org-config-deps.http.test.ts,permission-set.test.ts,point-defaults.test.ts,hooks.test.ts}`,
  `test/setup/setup-checks.http.test.ts`, `test/platform/{ops-extension-config,ops-catalog}.test.ts`,
  `test/catalog/{admin-scope,platform-update,themes-scope}.test.ts`, `test/models/embedding-hooks.test.ts`,
  `test/runtime/queued-abort.test.ts`, `test/ui/permissions.test.ts`, `test/client/*.http.test.ts`,
  `test/helpers/extensions.ts`, and directory sync tests that pass `orgConfig`
- `.changeset/*.md` (bump `@capybara-hq/kernel`, `@capybara-hq/testing`, `@capybara-hq/capybara` as the
  repo's image changesets do)

**Interfaces:**
- Consumes: Task 1 point types; Task 4 levels; `EffectiveConfigs.get(orgId, plugin)` (unchanged).
- Produces (HTTP, consumed by Task 7): `OrgExtensionView` = today's minus `config`, `secrets`,
  `orgConfigSchema`; `configurable: boolean` = at least one overridable field; `needsConfig` from the
  effective config only. `PUT /orgs/:orgId/extensions/:extension` body `{ enabled?, force?, confirm? }`.

- [ ] **Step 1: Failing tests:** `org-config.http.test.ts`: a PUT with `config` → 400 (strict body);
  the view of a web provider fixture whose platform key is empty is `needsConfig: true` and
  `configurable: true`; after the org saves a copy with its key, `needsConfig: false`.
  `point-defaults.test.ts`: the provider receives `config` (effective) and no `orgConfig`; a provider
  whose `configured(config)` is false is excluded. Directory sync test: `listMembers` gets the org's
  copy, never another org's (two orgs, two copies, assert each call's `config`). Readiness: an extension
  with overridable fields and `needsConfig` yields `needs_config`.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/extensions/org-config.http.test.ts packages/kernel/test/extensions/point-defaults.test.ts` → FAIL.
- [ ] **Step 3:** Implement the removals and rewire every call site to the effective config; Platform
  operation descriptions drop `orgConfig` (keep `deploymentCopy`), and the parity test follows the shared
  schema.
- [ ] **Step 4:** `pnpm exec vitest run packages/kernel/test/extensions packages/kernel/test/platform packages/kernel/test/setup packages/kernel/test/catalog`
  and `pnpm exec vitest run tools/checks/test/platform-parity.test.ts` → PASS; `pnpm check:platform-ops` → passed.
- [ ] **Step 5: Commit** `feat(kernel): remove org-only extension config`

### Task 6: bootstrap fixed set

**Files:**
- Modify: `packages/kernel/bootstrap.json` (`openai-compatible`: `"required": false`; nothing else),
  `tools/checks/src/bootstrap.ts` (rule `bootstrap-fixed-set`), `tools/checks/test/bootstrap*.test.ts`,
  red fixture under `tools/checks/fixtures/bootstrap/` (a manifest with an extra required entry and one
  missing builtin), `tools/checks/README.md` (the bootstrap line), and any kernel/e2e test setup that
  assumed openai-compatible enabled in every org (grep `openai-compatible` under `packages/*/test`,
  `apps/*/test`, `docker/`)

**Interfaces:**
- Produces: `BOOTSTRAP_FIXED = ["object-store-s3", "skills-core", "file-preview"]` exported from
  `tools/checks/src/bootstrap.ts`; finding rule `bootstrap-fixed-set`.

- [ ] **Step 1: Failing test:** the red fixture yields `bootstrap-fixed-set` naming the extra and the
  missing entry; the real manifest (after the edit) yields none.
- [ ] **Step 2:** `pnpm exec vitest run tools/checks/test/bootstrap.test.ts` → FAIL.
- [ ] **Step 3:** Implement the rule (entries with `required: true` or `builtin: true` must equal the set)
  and edit `bootstrap.json`.
- [ ] **Step 4:** Re-run → PASS; `pnpm check:bootstrap` → passed (offline mode).
- [ ] **Step 5: Commit** `feat(bootstrap): only object-store-s3, skills-core and file-preview are fixed`

### Task 7: web

**Files:**
- Modify: `apps/web/src/lib/extensions.ts:70,177` (drop `orgConfigSchema`, `config`, `secrets`),
  `src/components/OrgExtensionSheet.tsx` (one form: the overridable fields; drop the org-config section),
  `src/components/config-form/org.ts` (drop `orgConfig`, readonly mapping), `config-form/deployment.ts:81`
  (`level: f.level`), `config-form/model.ts:205-208` (`level?: "platform" | "override"`),
  `config-form/ConfigForm.tsx:345-349`, `src/components/useOrgExtensionActions.tsx`,
  `src/components/PluginSwitch.tsx`, `src/components/CatalogInstallWizard.tsx`,
  `src/app/(app)/connectors/view.tsx` and `src/app/(app)/settings/models/view.tsx` where they read the
  dropped fields, `src/dev/catalog/*` fixtures, `messages/zh.json` and `messages/en.json`
  (`…level.hidden` → `level.platform` = `仅平台` / `Platform only`; remove `level.readonly`; keep
  `level.override` = `组织可覆盖` / `Org can override`), tests `apps/web/test/{org-overrides,config-form-adapters,web-tools,channels,extensions-identities,catalog-pages,model-setup,setup-guide-section,setup-check-rows}.test.tsx`
  as they break
- Modify: `src/components/ExtensionDeploymentConfig.tsx`: a hint on lark's / slack's `directory` field
  is plugin copy, not web code (skip here; Task 15 puts it in the field's `x-ui` description)

**Interfaces:**
- Consumes: Task 5 HTTP view and PUT body; Task 4 `DeploymentConfigField.level`.

- [ ] **Step 1: Failing tests:** `org-overrides.test.tsx`: the sheet renders no read-only field and no
  org-config section; `config-form-adapters.test.ts`: a deployment field with `level: "platform"` shows
  the tag text `Platform only` (en) and `仅平台` (zh).
- [ ] **Step 2:** `pnpm exec vitest run apps/web/test/org-overrides.test.tsx apps/web/test/config-form-adapters.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm exec vitest run apps/web/test` → PASS; `pnpm check:web-ui && pnpm check:i18n` → passed.
- [ ] **Step 5: Commit** `feat(web): one org config form, platform-only level tag`

### Task 8: core docs and rules

**Files:**
- Modify: `AGENTS.md` (Config and Extensions lines as spec "AGENTS.md rules touched" states),
  `.agents/skills/adding-config/SKILL.md`, `.agents/skills/writing-extensions/SKILL.md`,
  `.agents/skills/writing-plugins/SKILL.md`, `.agents/skills/writing-model-providers/SKILL.md`,
  `.agents/skills/writing-channels/SKILL.md` (directory@1 `configured(config)`), `docs/architecture.md`
  if it describes `config.org`

- [ ] **Step 1:** Edit; grep the repo for leftovers: `rg -n "orgAccess|x-org|config\.org|orgConfig|\"readonly\" \| \"override\"" --glob '!**/CHANGELOG.md' --glob '!docs/superpowers/{specs,plans}/**'` → only historical files.
- [ ] **Step 2:** `pnpm check` → passed.
- [ ] **Step 3: Commit** `docs: unified plugin config rules and skills`

### Task 9: core verify and PR

- [ ] `CAPYBARA_TEST_WORKERS=4 pnpm verify` → ok (one full verify at a time on this machine).
- [ ] Fresh-context self-review of `git diff origin/main...HEAD` against AGENTS.md and the touched skills.
- [ ] After the maintainer agrees: push, open the PR (`Closes #720` stays out until Phase 2 is done; the
  body links the spec and this plan), ready when green. Merge and the Version Packages release
  (SDK + plugin-tools) are the maintainer's call.

## Phase 2: plugins (one PR, `/Users/grant/Capybara/plugins/.claude/worktrees/feat-core-720-unified-plugin-config`)

Starts after the SDK and plugin-tools releases from Phase 1. Every task raises its own plugins'
`package.json` dependency and manifest `sdk` ranges to `^<released SDK version>` and adds one
changeset per plugin. Read the plugins repo's `writing-plugins`, `writing-model-providers`,
`writing-channels` skills first. Live-API tests per those skills after Tasks 11–13 (`~/.capybara-test.env`,
never printed).

### Task 10: SDK bump and mechanical marks

**Files:** root `package.json:39`, `pnpm-workspace.yaml:11-12` (override to the released SDK),
`plugins/{google,telegram,object-store-s3,device-docker,device-e2b,push-apns,push-fcm,push-jpush,example-counter}/src/**`
(root `platformOnly(...)` on the deployment schema), `plugins/{deepseek,ark,bailian}/src/**` (drop
`orgAccess`; deepseek's private `resolve`/`sameUrl` → `configUrlFetch`), their tests
(`*/test/deployment-config.test.ts`, `google/test/config.test.ts:124`)

- [ ] Failing tests: each root-marked plugin's packed schema has `"x-platform-only": true` at the root;
  deepseek/ark/bailian schemas have no `x-platform-only` and no `x-org`; deepseek still refuses a
  private org `baseUrl` through the injected net fetch.
- [ ] Implement; `pnpm exec vitest run plugins/<each>/test` → PASS; `pnpm exec capybara-plugin check` on
  these plugins → no `plugin-config-unbound` / `plugin-org-url-net`.
- [ ] Commit `feat: classify plugin config fields (platform-only roots, deepseek configUrlFetch)`

### Task 11: anthropic

**Files:** `plugins/anthropic/src/index.ts:44,131-226`, `src/map-request.ts` (unchanged unless the
config type moves), tests under `plugins/anthropic/test/`

**Interfaces:** `serverFallbacks: platformOnly(z.enum(["default","off"]).default("default"))`; lenient
`CallConfig` parse in setup; client per call from `opts.config` (platform values only for calls without
`opts.config`), `fetch: configUrlFetch(ctx.net, { url: baseUrl ?? ANTHROPIC_DEFAULT, platform: platformBaseUrl(), orgId })`;
kv key `models:v4:<sha256(baseUrl)>:<id>`.

- [ ] Failing tests: setup with `{}` does not throw (Review Focus 3); an org config without `apiKey`
  → `ModelError("auth")` before any request, never the platform key; an org `baseUrl` of
  `http://10.0.0.1` is refused via the injected net fetch; two org configs with different `baseUrl`
  write and read distinct kv keys (Review Focus 4); `serverFallbacks` reads `ctx.config` only.
- [ ] Implement (deepseek template, spec §5.7); tests → PASS; `capybara-plugin check` clean.
- [ ] Commit `feat(anthropic): org-overridable key, endpoint and models`

### Task 12: openai

**Files:** `plugins/openai/src/index.ts:23-203`, tests.
- [ ] Failing tests: as Task 11 for `apiKey` / `baseUrl` (no kv); `models`, `reasoningSummary`,
  `imageModels`, `organization` come from the org copy in `listModels` / `stream` / `generateImage`.
- [ ] Implement; tests → PASS; check clean.
- [ ] Commit `feat(openai): org-overridable config`

### Task 13: openai-compatible

**Files:** `plugins/openai-compatible/src/index.ts:16-213`, tests.
**Interfaces:** per endpoint `fetch: configUrlFetch(ctx.net, { url: e.baseUrl, platform: platformEndpoints().map((p) => p.baseUrl), orgId })`.
- [ ] Failing tests (Review Focus 5): an org copy keeping a platform endpoint uses the global fetch; an
  added endpoint at `http://10.0.0.2` is refused through the net fetch; a copy with `apiKeys: {}` calls
  the kept endpoint without `Authorization`; setup with `{}` does not throw.
- [ ] Implement; tests → PASS; check clean.
- [ ] Commit `feat(openai-compatible): org-overridable endpoints`

### Task 14: jina

**Files:** `plugins/jina/src/{config,index,search,reader,http}.ts`, tests including
`test/kernel.http.test.ts:77-160`, `test/live/jina.live.test.ts`.
- [ ] Failing tests: `configured(config)` false without `apiKey`, true with; search/reader read
  `apiKey`, `searchUrl`, `readerUrl` from `config`; an org `searchUrl` on a private host is refused;
  kernel http: a second org without a platform key is `needsConfig` (not `extension.config_invalid`),
  and after saving a copy via `/overrides` it works.
- [ ] Implement (`JinaOrgConfig` deleted); tests → PASS; check clean.
- [ ] Commit `feat(jina): move the API key into the overridable deployment config`

### Task 15: lark and slack

**Files:** `plugins/lark/src/{config,directory,index,tenant}.ts`, `plugins/slack/src/{config,directory,index}.ts`,
their tests (directory, channel, config-hints, kernel dual tests, live tests).
**Interfaces:** lark deployment `directory: z.object({ appId: LarkAppId, appSecret: secret(z.string().min(1)) }).partial().optional()`
(overridable), login keys `region`, `apiUrl`, `accountsUrl`, `appId`, `appSecret` marked `platformOnly`;
slack `directory: z.object({ teamId, botToken }).partial().optional()`, `apiUrl`, `openidUrl`,
`clientId`, `clientSecret` marked `platformOnly`. Both `directory` fields carry an `x-ui` description:
"Every organization that follows the platform syncs this tenant's members" (zh in the plugin's i18n
form if it has one).
- [ ] Failing tests: `configured(config)` reads `config.directory`; `listMembers` uses the org copy's
  credentials; lark's same-app guard still fires; the kernel dual tests save the directory app through
  `/overrides` instead of the org PUT.
- [ ] Implement; tests → PASS; check clean.
- [ ] Commit `feat(lark,slack): directory credentials become overridable deployment config`

### Task 16: plugins docs, marketplace, verify, PR

**Files:** `.agents/skills/{writing-extensions,writing-model-providers,writing-channels}/SKILL.md`,
READMEs listed in the inventory §4, `.capybara-plugin/marketplace.json` (regenerate with
`capybara-plugin marketplace`), changesets.
- [ ] `pnpm verify` → ok; fresh-context self-review; push and PR after agreement (`Refs capybara-hq/core#720`).

## Phase 3: core re-pin (separate PR after the plugins release)

### Task 17: bootstrap re-pin

- [ ] Re-pin `packages/kernel/bootstrap.json` entries and `marketplace.commit` to the released plugins
  (only when no other session's restage window is open); `pnpm check:bootstrap --network` (or the repo's
  network mode) → passed; PR `chore: pin plugins for unified config`, body `Closes #720`.

---

## Wave plan (copy into the SDD ledger before Task 1)

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 SDK marks + shape | – | plugin-sdk | normal | 1 | batch W1 |
| 6 bootstrap fixed set | – | bootstrap.json, tools/checks/bootstrap | normal | 1 | batch W1 |
| 2 configUrlFetch | 1 (index.ts, api report) | plugin-sdk | normal | 2 | batch W2 |
| 4 kernel levels | 1 | kernel extensions/org-levels, overrides, model-fake | **high** | 2 | alone, most capable |
| 3 plugin-tools checks | 1, 2 | plugin-tools, tools/checks/README | normal | 3 | batch W3 |
| 5 kernel drops config.org | 1, 4 | kernel org-config, catalog, points, ops, testing fixtures | **high** | 3 | alone, most capable |
| 7 web | 4, 5 (HTTP shape fixed in plan) | apps/web | normal | 3 | batch W3 |
| 8 core docs | 1–7 | AGENTS.md, skills, tools/checks/README | normal | 4 | batch W4 |
| 9 verify + PR | all | – | – | 4 | final whole-branch review |
| 10 plugins marks | SDK release | root, 12 plugin dirs | normal | P1 | batch P1 |
| 11 anthropic | 10 | plugins/anthropic | **high** (cross-org cache, org URL) | P2 | alone |
| 12 openai | 10 | plugins/openai | normal | P2 | batch P2 |
| 13 openai-compatible | 10 | plugins/openai-compatible | **high** (org URL vs internal endpoints) | P2 | alone |
| 14 jina | 10 | plugins/jina | normal | P2 | batch P2 |
| 15 lark + slack | 10 | plugins/lark, plugins/slack | **high** (cross-tenant directory) | P2 | alone |
| 16 plugins docs + PR | 10–15 | skills, READMEs, marketplace.json | normal | P3 | final review |
| 17 re-pin | plugins release | bootstrap.json | normal | – | – |

`tools/checks/README.md` is touched by Tasks 3, 6 and 8: Task 6 (W1) and Task 3 (W3) edit different
lines in different waves; Task 8 only reads it for leftovers. Task 7 and Task 5 share no file; Task 7
codes against the HTTP shape stated in Task 5's Interfaces.
