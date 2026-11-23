# Unified plugin config: overridable by default, platform-only by mark

Issue: [core#720](https://github.com/capybara-hq/core/issues/720). Amends the two-level config of
[platform and org layering](2026-11-07-platform-org-layering-design.md) (spec A) §5 and §6; everything
there that this document does not change stays (copy on edit, whole copy, compare / take / reset, the
platform may leave overridable fields empty, effective config per org-bound call, `needsConfig`).

Inventory: capybara-hq/plugins at `1c9b0dd` (origin/main, 2026-11-23), core at `d7accdbd5`.

## 1. Why

Each plugin configures itself its own way today:

- Only ark, bailian and deepseek mark fields `orgAccess(…, "override")`. anthropic, openai,
  openai-compatible, jina's URLs and the rest are platform-only because nobody opted them in, not
  because a reason exists.
- lark, slack and jina keep a separate `config.org` schema: the org fills its own fields and the
  platform cannot offer a shared value.
- openai-compatible is a `required` bootstrap entry, fixed on in every org, though it is an ordinary
  model provider.
- The `readonly` level exists and no plugin uses it.

Four behaviours for one question ("who configures this plugin for my org?") make the org settings
page unpredictable and every new plugin a fresh decision.

## 2. Decisions (maintainer, 2026-11-23; not reopened here)

1. Builtin and fixed in every org: only `object-store-s3`, `skills-core`, `file-preview`.
   `openai-compatible` becomes an ordinary optional bootstrap entry.
2. Every other plugin: the platform configures it; the super admin picks a scope at import
   (`all` / `named` / `optional`); orgs switch it on; orgs may override its config.
3. Deployment config fields are **org-overridable by default**. A field is platform-only only when
   marked. Candidates: kernel trust boundaries (device-docker's Docker endpoint), platform operational
   switches (anthropic `serverFallbacks`).
4. Overriding needs the plugin's cooperation: an overridable URL an org sets goes through `ctx.net`
   (deepseek pattern), enforced by a check proven red first. Secrets keep today's rule: an org copy never
   receives an overridable platform secret.
5. `config.org` goes away. lark, slack and jina move those fields into the deployment schema as
   overridable fields. Channel connection config is a separate layer and unchanged.
6. `readonly` is removed. Two levels remain: overridable (default) and platform-only.

Nothing has been released: no compatibility layers, no aliases.

## 3. Goals, non-goals, anti-goals

Goals

- One config model for every plugin, stated once in the SDK and enforced by checks.
- The per-plugin, per-field classification below, applied in capybara-hq/plugins.
- An org-set URL never reaches the network without `ctx.net`; a platform secret never reaches an
  org-chosen endpoint.

Non-goals

- Making `device-provider@1`, `connector@1`, `channel@1`, `identity-source@1`, `object-store@1` or
  `push-provider@1` org-bound (passing the effective config into their calls). Their plugins' fields
  are platform-only under this design (§5.3); an org-bound version of a point is its own design.
- Changing copy semantics (whole copy, secrets start empty, compare / take / reset), channel
  connection config, connector endpoint config, the scope model or org enablement.
- The readiness fix for "model step done but no usable model" (in flight separately).

Anti-goals

- A kernel heuristic that guesses which fields an org may set. The plugin declares; checks enforce.
- An org-visible field that does nothing (overridable on a plugin whose calls never carry the org's
  config).
- A third level or an "org only" level coming back under another name.

## 4. Current state the builder starts from

- SDK `packages/plugin-sdk/src/org-access.ts`: `OrgAccess = "readonly" | "override"`, `orgAccess()`,
  `orgAccessOf()`; meta `org`, published as `"x-org"` by `configJsonSchema` (`config-ui.ts`), allowed on
  top-level deployment properties only. `defineExtension({ config: { deployment?, org? } })`
  (`define-extension.ts:36`).
- `web-search@1` / `web-fetch@1` (`web.ts`) and `directory@1` (`directory.ts`) take `orgConfig` plus
  an optional effective `config`, and `configured?(orgConfig, config?)`.
- Kernel `extensions/org-levels.ts`: `FieldLevel = "hidden" | "readonly" | "override"`, a field without
  `orgAccess` is `hidden`; `relaxOverridable` / `parseLoadGate` let the platform leave required
  overridable fields empty. `extensions/org-overrides.ts` and `effective-config.ts` keep copies in
  `extension_org_overrides` (migration `0086`) and secrets under `plugin-override:<plugin>:<path>`.
- `extensions/org-config.ts` (`OrgExtensionConfigs`): org enablement plus the `config.org` values in
  `extension_org_configs.config` and org secrets `plugin-config:<plugin>:<path>`; `config.org` is also
  read in `catalog/org-catalog.service.ts:267`, `catalog/scope-sync.ts:496`,
  `setup/setup-checks.service.ts:872`, `extensions/permission-set.ts:154` (permission keys
  `config.org:*`), and the SDK's `plugin-package.ts:197`.
- `agents/readiness.service.ts:42`: `orgCanConfigure = configurable || overrideState !== "none"`.
- `plugin-tools` `check/org-override.ts`: warning `plugin-org-override-unbound` (an `override` field on
  an extension with no org-bound entry).
- `bootstrap.json`: `required: true` on `openai-compatible` and `object-store-s3`; `builtin: true` on
  `skills-core` and `file-preview`. No kernel code depends on `openai-compatible` by name.
- Web: `components/config-form/org.ts` maps `readonly` to disabled 平台配置 fields and renders the
  `config.org` form; `OrgExtensionSheet`, `OrgOverrideDiff`, the admin level tags
  (组织不可见 / 组织只读 / 组织可覆盖).

## 5. Design

### 5.1 Two levels, overridable by default

| Level | Platform | Org | Declared by |
|---|---|---|---|
| Overridable (default) | sets the default, may leave a required field empty | follows the platform until it saves a copy | nothing |
| Platform-only | sets it | never sees it | `platformOnly(…)` |

- Levels still sit on top-level keys of the deployment schema (spec A §5.2); a nested field has its
  top-level key's level. An author who needs a nested split splits the object.
- A whole schema may be marked: `platformOnly(z.object({…}))` makes every key platform-only, for
  plugins with no org-bound entry (§5.3). Marking the root and a key is allowed and means the same.
- Platform-only fields are not sent to orgs (the org API omits them), as `hidden` fields today. The
  platform-only secrets stay in an org's effective config (an org cannot set them), as today; an author
  never sends one to an endpoint taken from an overridable field (TSDoc of `platformOnly`, and the
  writing-extensions skills).
- Everything else of spec A §5.3 to §5.8 is unchanged. Consequence worth stating: with far more
  overridable fields, an org that copies to change any one of them brings its own value for every
  overridable secret (decision 4 keeps that rule).

### 5.2 SDK

- Remove `OrgAccess`, `orgAccess`, `orgAccessOf`. Add `platformOnly(schema)` (meta
  `platformOnly: true`, merged like `secret()` / `hot`) and `isPlatformOnly(schema)` (sees through the
  same wrappers `orgAccessOf` did). `configJsonSchema` publishes `"x-platform-only": true`;
  `validateConfigUi` rejects it anywhere but the root and its top-level properties. `x-org` is gone.
- `defineExtension({ config: { deployment? } })`: `org` is removed. The `deployment` key stays so the
  permission keys (`config.deployment:*`), `plugin.json` `extension.configSchemas.deployment` and the
  kernel's storage paths keep their names (**designer's call:** flattening `config` buys nothing and
  renames every data path).
- `web-search@1`, `web-fetch@1`, `directory@1`: `orgConfig` is removed; `config` (the effective config)
  becomes required in the call arguments, and `configured?(config: unknown): boolean`.
- New helper `configUrlFetch(net, { url, platform, orgId })` (`url.ts` next to the URL helpers): returns
  the global `fetch` when `url` equals the platform's value (`platform`: a string, a list for list
  fields such as openai-compatible's endpoints, or undefined; trailing slashes ignored, as deepseek's
  `sameUrl`), otherwise `(input, init) => net.fetch(input, init, { orgId })`. It generalises deepseek's
  private `resolve` / `sameUrl`, is pure (the caller passes `ctx.net` and the platform value read from
  `ctx.config` at call time, so hot changes apply), and gives the check (§5.5) one call to look for.
  Vendor SDKs take it as their `fetch` option (openai, `@anthropic-ai/sdk`).
- The SDK's permission-key derivation (`plugin-package.ts`) drops `config.org`.
- `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`; the agent docs topic on config
  (`packages/plugin-sdk/agent-docs/`) is rewritten.

### 5.3 Which entries are org-bound

An overridable value reaches an extension only in the per-call `config` of an org-bound entry
(spec A §6): extension tools, `ctx.ui` views and actions, hooks with an org, `model-provider@2`,
`web-search@1`, `web-fetch@1`, `directory@1`, `file-preview@1`.

`device-provider@1`, `connector@1`, `channel@1`, `identity-source@1` (runs before an org is known),
`object-store@1` and `push-provider@1` calls carry no effective config. An extension whose only entries
are these has every field platform-only; the check (§5.5) makes that an error, not a warning, so no org
ever sees a field that does nothing. This is a classification rule, not a kernel guess: the plugin marks
`platformOnly`, the check verifies.

### 5.4 Kernel

- `extensions/org-levels.ts`: `FieldLevel = "platform" | "override"`; a top-level key is `override`
  unless the key or the root is platform-only (`isPlatformOnly`, or `x-platform-only` for the static
  form schema of a module this replica has not loaded). `relaxOverridable`, `parseLoadGate` and
  `missingOverridable` keep their logic over the new levels, so the platform may leave any required
  non-marked field empty and orgs that follow are `needsConfig` (spec A §5.4a).
- `readonly` goes everywhere: `OrgOverrideField.level` becomes `"override"` only (the field list holds
  overridable fields), `deployment-config.ts:99`, the org form.
- `config.org` goes:
  - `OrgExtensionConfigs` keeps org enablement only; the org PUT body loses `config` / `secrets`
    (errors `extension.no_org_config` and the org-config validation paths go); `OrgExtensionView` loses
    `orgConfigSchema` and the org config values.
  - Point defaults (`point-defaults.ts`) and directory sync (`orgs/directory-sync.ts`) pass the
    effective `config` only; `configured(config)` decides, as today with `orgConfig`.
  - Setup checks (`setup-checks.service.ts:872`), scope sync (`scope-sync.ts:496`), the org catalog
    (`org-catalog.service.ts:267`) and the permission set (`permission-set.ts:154`) read the deployment
    schema and the effective config instead.
  - Storage: the code stops reading and writing `extension_org_configs.config` and the
    `plugin-config:` org secrets in this change. The column drop and the secret purge are a contract
    migration in a later release (writing-migrations two-step rule); no migration in this change.
- Views: `needsConfig` comes from the effective config alone; `configurable` = the extension has at
  least one overridable field; `overrideState` unchanged. Readiness (`readiness.service.ts:42`):
  `orgCanConfigure = configurable` (an extension with a copy is configurable by definition).
- Platform operations: the org extension write loses `config` / `secrets` with the route's shared
  schema (parity test follows); the override operations are unchanged.
- Bootstrap: `openai-compatible` loses `required`, becoming an optional preinstall (off in every org
  until switched on, like anthropic). `check:bootstrap` gets rule `bootstrap-fixed-set`: the entries
  with `required: true` or `builtin: true` are exactly `object-store-s3`, `skills-core`, `file-preview`
  (decision 1; a change to that set is a maintainer decision that edits the check with its reason).
  The fixtures and test stacks that relied on openai-compatible being on everywhere switch it on in
  their org.

### 5.5 Checks (plugin-tools `capybara-plugin check`, run in the plugins repository's CI)

Both are proven red first with fixtures under `packages/plugin-tools/test/fixtures/`.

- **`plugin-config-unbound` (error; replaces the warning `plugin-org-override-unbound`):** an extension
  with at least one overridable deployment field (not platform-only) that registers no tool, no `ctx.ui`
  view or action, no hook, and provides none of the org-bound points of §5.3. The message names the
  fields and says to mark them `platformOnly`.
- **`plugin-org-url-net` (error):** for each overridable top-level key, every URL in it (JSON Schema
  `format: "uri"`, nested properties and array items included, which `z.url()` / `.url()` emit) must
  reach the network through `configUrlFetch`: the extension's source (oxc, as `findCtxCalls`) must
  contain a `configUrlFetch(` call, imported from `@capybara-hq/plugin-sdk`, whose `url` argument reads
  that field's leaf name (`.baseUrl`, `["baseUrl"]`, a destructured `baseUrl`). A second finding of the
  same rule: an overridable string field whose key ends in `url`, `uri`, `endpoint` or `host` (case
  insensitive) without `format: "uri"` (declare it `z.url()` or mark it platform-only), so a URL cannot
  dodge the rule by its type. Known gaps, listed in the check's doc like `kc-global-fetch`: a field
  routed through `configUrlFetch` in one place and through the global `fetch` in another is not seen; a
  host assembled from non-URL fields (bailian's region enum and regex-limited workspace label) is not a
  URL field, and the reviewer judges such hosts (both of today's are vendor-fixed domains).
- `tools/checks/README.md` in core and the writing-plugins skill list both rules; they run in full (cheap,
  per plugin).

### 5.6 Web

- Org extension sheet: one form, the overridable fields (following / copy as today); the `config.org`
  section and the read-only rendering go. Copy text unchanged where it still applies.
- Admin deployment form: the level tag per field is 组织可覆盖 or 仅平台 (en: "Org can override" /
  "Platform only"); 组织只读 goes. i18n zh and en.
- Platform pages that list org copies (spec A §5.7) unchanged.

### 5.7 Plugins (capybara-hq/plugins)

Code work per plugin, beyond the marks in §6:

- **anthropic, openai, openai-compatible:** follow the deepseek template: lenient setup parse
  (`DeploymentConfig.partial()` for the required overridable keys, `safeParse`), platform values only as
  defaults for calls without `opts.config`, resolve the config as a whole per call (never mixing a
  platform key into an org config), build the vendor client per call with `fetch` from
  `configUrlFetch`. openai-compatible passes the list of platform endpoint URLs as `platform`, so an
  endpoint an org copy keeps from the platform stays on the global fetch (the super admin set it) and an
  org's own endpoint goes through `ctx.net`. anthropic re-keys its `ctx.kv` model cache by endpoint
  (`models:v4:<sha256(baseUrl)>:<id>`): `ctx.kv` is extension-wide, so an org endpoint must not write
  entries other orgs read.
- **deepseek:** replace its private `resolve` / `sameUrl` with `configUrlFetch`; drop `orgAccess`.
  **ark, bailian:** drop `orgAccess`; no URL field.
- **jina:** `apiKey` moves into the deployment schema (overridable secret, optional for the platform);
  `searchUrl` / `readerUrl` are read per call from `config` through `configUrlFetch`; `configured`
  reads `config`.
- **lark:** the org's directory app moves to a deployment key `directory: { appId, appSecret }`
  (the top-level `appId` / `appSecret` are the login app and stay platform-only); the directory reads
  `config.directory`; the same-app guard against the login app stays.
- **slack:** the org's `teamId` / `botToken` move to `directory: { teamId, botToken }` (symmetric with
  lark; avoids two meanings of `botToken` next to the connection's).
- **Every plugin with platform-only fields:** the marks of §6; plugins with no org-bound entry mark the
  root.
- Tests: per plugin, the per-call config path, "an org config without a key never falls back to the
  platform key", and for each overridable URL a refused private org URL through an injected net fetch
  (writing-model-providers rule). The kernel http tests of jina / lark / slack move from the org config
  PUT to the overrides route.
- Docs: writing-extensions, writing-model-providers and writing-channels skills, READMEs (§4 of the
  inventory lists the lines). `marketplace.json` regenerated: lark, slack and jina permission keys
  change from `config.org:*` to `config.deployment:*` (a re-approval, acceptable before 0.1.0).
- Every touched plugin raises its `package.json` and manifest `sdk` ranges to the SDK release with
  `platformOnly` and `configUrlFetch`; one changeset per plugin; core re-pins `bootstrap.json` after the
  plugins release.

## 6. Classification, per plugin and field

"Platform-only" carries its reason. "Overridable" with "via `configUrlFetch`" needs code (§5.7).
Plugins without config (device-local, memory, file-preview, todo, theme-cyberpunk, example-board,
github, skills-core) and connector endpoint schemas (connector-mcp, connector-openapi: a separate
per-connector layer, already on `ctx.net`) are out of scope.

### 6.1 Model providers

| Plugin | Field | Secret | Today | New | Reason / note |
|---|---|---|---|---|---|
| anthropic | `apiKey` | yes | platform | overridable | |
| anthropic | `baseUrl` | | platform | overridable | via `configUrlFetch`; kv cache re-keyed by endpoint |
| anthropic | `models` | | platform | overridable | |
| anthropic | `serverFallbacks` | | platform | **platform-only** | platform operational switch (decision 3's example): whether requests opt into Anthropic's server-side fallback beta is a deployment policy |
| openai | `apiKey` | yes | platform | overridable | |
| openai | `baseUrl` | | platform | overridable | via `configUrlFetch` |
| openai | `organization` | | platform | overridable | goes with the org's key |
| openai | `models` | | platform | overridable | nested model fields follow the key |
| openai | `reasoningSummary` | | platform | overridable | |
| openai | `imageModels` | | platform | overridable | |
| openai-compatible | `endpoints` | | platform | overridable | each `baseUrl` via `configUrlFetch` with the platform's endpoint URLs as `platform` |
| openai-compatible | `apiKeys` | yes | platform | overridable | a copy starts `{}`: a kept platform endpoint is called without a key unless the org enters one |
| deepseek | `apiKey` | yes | override | overridable | |
| deepseek | `baseUrl` | | override | overridable | already on `ctx.net`; moves to `configUrlFetch` |
| ark | `apiKey` | yes | override | overridable | |
| ark | `region` | | override | overridable | enum of vendor hosts, no free URL |
| ark | `management` | yes | override | overridable | signs control-plane calls with the org's AK/SK |
| bailian | `apiKey` | yes | override | overridable | |
| bailian | `region` | | override | overridable | enum |
| bailian | `workspaceId` | | override | overridable | regex-limited host label under `*.maas.aliyuncs.com`; not a URL field |

### 6.2 Web providers

| Plugin | Field | Secret | Today | New | Reason / note |
|---|---|---|---|---|---|
| jina | `apiKey` | yes | org schema | overridable | moved from `config.org`; platform may supply a shared key, else orgs are `needsConfig` |
| jina | `searchUrl` | | platform | overridable | via `configUrlFetch` |
| jina | `readerUrl` | | platform | overridable | via `configUrlFetch` |

### 6.3 Channels, login and directory

| Plugin | Field | Secret | Today | New | Reason / note |
|---|---|---|---|---|---|
| lark | `region` | | platform | **platform-only** | used by login (pre-org) and the shared API base |
| lark | `apiUrl` | | platform | **platform-only** | read by `channel@1` and login, which carry no org config; the WebSocket leg cannot use `ctx.net` |
| lark | `accountsUrl` | | platform | **platform-only** | login authorize URL; `identity-source@1` runs before an org is known |
| lark | `appId` | | platform | **platform-only** | the login app (`identity-source@1`) |
| lark | `appSecret` | yes | platform | **platform-only** | the login app |
| lark | `directory` (`appId`, `appSecret`) | yes (`appSecret`) | org schema | overridable | moved from `config.org`, renamed (§5.7) |
| slack | `apiUrl` | | platform | **platform-only** | read by `channel@1` (Socket Mode WebSocket) and login; no org config there |
| slack | `openidUrl` | | platform | **platform-only** | login (pre-org): authorize and JWKS |
| slack | `clientId` | | platform | **platform-only** | login client (pre-org) |
| slack | `clientSecret` | yes | platform | **platform-only** | login client (pre-org) |
| slack | `directory` (`teamId`, `botToken`) | yes (`botToken`) | org schema | overridable | moved from `config.org`, renamed (§5.7) |
| telegram | `apiUrl` (root marked) | | platform | **platform-only** | only `channel@1`, which carries no org config |
| google | all (root marked): `clientId`, `clientSecret`, `allowedDomains`, `allowConsumerAccounts`, `endpoints` | `clientSecret` | platform | **platform-only** | only `identity-source@1` (pre-org); the domain gate and the issuer / JWKS anchors decide who may sign in to the deployment |

Channel connection fields (lark, slack, telegram bot credentials and webhook secrets) are unchanged.

### 6.4 Devices, storage, push, examples

| Plugin | Field | Secret | Today | New | Reason / note |
|---|---|---|---|---|---|
| object-store-s3 | all (root marked): `endpoint`, `region`, `bucket`, `accessKeyId`, `secretAccessKey`, `forcePathStyle`, `publicEndpoint` | keys | platform | **platform-only** | the deployment's one store; `object-store@1` is not org-bound; builtin and fixed (decision 1) |
| device-docker | all (root marked): `endpoint`, `runtime`, `network`, `egressProxyImage`, `volumeDriver`, `deniedCidrs`, `refuseOpenNetwork` | | platform | **platform-only** | trust boundary (decision 3's example: the socket proxy decides where code runs; runtime, egress image and closed ranges decide isolation); `device-provider@1` carries no org config |
| device-e2b | all (root marked): `apiKey`, `apiUrl`, `domain`, `template`, `timeoutSeconds`, `domainAllowlist` | `apiKey` | platform | **platform-only** | `device-provider@1` carries no org config; `domain`, `template`, `domainAllowlist` are trust boundaries regardless. An org's own E2B account would need an org-bound device-provider design |
| push-apns | all (root marked): `key`, `keyId`, `teamId`, `bundles` | `key` | platform | **platform-only** | credentials of the deployment's app builds; `push-provider@1` is not org-bound |
| push-fcm | all (root marked): `serviceAccount`, `applicationIds` | `serviceAccount` | platform | **platform-only** | same |
| push-jpush | all (root marked): `appKey`, `masterSecret`, `applicationIds`, `xiaomi`, `oppo`, `vivo`, `huawei` | `masterSecret` | platform | **platform-only** | same |
| example-counter | `step` (root marked) | | platform | **platform-only** | only public routes and `counter@1`, no org-bound entry |

### 6.5 Core's own plugins and fixtures

- `plugins/model-fake`: `models` loses `orgAccess` (overridable by default); any other field per its use.
- `packages/testing` fixtures with `config.org` (`fake-web`, `fake-web-2`, `fake-im`, `fake-context`)
  move those fields into their deployment schema; kernel fixtures under `packages/kernel/test/fixtures/plugins/`
  (`orglevels*`, `orgrefined`, `orgcalls`, `orgwrapped`, `model-org-key`, `dir-opt`, …) switch to the
  new marks, and the `readonly` cases are deleted.

## 7. Risks

- **Directory credentials with a platform value.** If the super admin fills lark's or slack's
  `directory`, every org following the platform with the extension on syncs that one Lark tenant or Slack
  workspace (decision 5 allows a shared value). The platform form shows a hint on the `directory` field
  saying so; lark's same-app guard stays. Single-tenant deployments are the intended use of a shared
  value.
- **More copies need keys.** An org changing a model list must also enter its own key (§5.1). Accepted
  by decision 4; the first-save rule of spec A §5.4 already asks in the same save.
- **Check gaps** (§5.5) are listed; review covers a URL routed two ways.

## AGENTS.md rules touched

- **Config** (changes): "A deployment field may carry an org level (`orgAccess(schema, "readonly" |
  "override")`, `x-org`; no level = platform only, hidden)" becomes: deployment fields are
  org-overridable by default; `platformOnly(schema)` (`x-platform-only`) marks a field or the whole
  schema platform-only; no `config.org`. The rest of the sentence (orgs follow until they save a copy,
  org-bound calls carry the effective config) stays.
- **Extensions** (changes): bootstrap: the required / builtin set is exactly object-store-s3,
  skills-core, file-preview (`check:bootstrap`); "the effective config (platform deployment config plus
  the org's copy of overridable fields …)" stays; add: an overridable URL is fetched through
  `configUrlFetch` / `ctx.net` (`plugin-org-url-net`), and an extension whose entries are not org-bound
  marks its config platform-only (`plugin-config-unbound`).
- **Plugins and the catalog** (applies): "a URL a person supplies to a plugin, through `ctx.net`" now
  covers every overridable URL; the new check enforces it.
- **Public API reports** (applies): SDK changes need `pnpm gen:sdk-api` and a changeset bumping
  `@capybara-hq/plugin-sdk`.
- **Platform tool** (applies): the org extension write's input changes through its shared schema.
- **Migrations** (applies, deferred): the `extension_org_configs.config` drop is a later contract step.
- **Web UI / i18n** (applies): new level tags in zh and en; no 企业, no Latin "agent".
- **Multi-replica discipline** (unchanged): no new state; effective config stays resolved from PG and
  Redis.
- **Before 0.1.0** (applies): no aliases for `orgAccess`, `x-org`, `config.org` or the old permission keys.

The skills that change: adding-config, writing-extensions, writing-plugins, writing-model-providers (core
and plugins), writing-channels (plugins).

## 9. Left to the builder

- Exact names of `configUrlFetch`'s options and of the check fixtures.
- Where the effective-config read replaces `config.org` in each kernel call site.
- Wording of the platform form's directory hint.
