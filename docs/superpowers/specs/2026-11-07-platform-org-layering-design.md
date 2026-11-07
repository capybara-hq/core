# Platform and org layering: org switches for `all`, two-level extension config, tool switches

- Date: 2026-11-07. Replaces the brainstorming notes `2026-11-06-platform-org-layering-notes.md`.
- Status: design, waiting for review. Follows `2026-11-05-plugin-component-management-design.md`
  (phases 1-4 implemented, merged into `main` with PR #88; cited below as "PCM"), which it amends
  where noted. Re-checked against `main` at `76b32e10` (2026-11-07).
- Unblocks: `2026-11-06-model-platform-providers-design.md` (design B), whose §5.3 and §5.5 build on
  §5 and §6 here.
- Markers: **(decided)** is the maintainer's answer during brainstorming (2026-11-06 and
  2026-11-07); **(designer's call)** is decided here on the maintainer's behalf and may be
  overturned in review. Items without a marker restate current code.
- Terms follow PCM §13.4b / §13.4c: **platform** = the deployment layer, run by the **super admin**;
  **org admin** = admin and above in an org.

## 1. Why

PCM gave every plugin and component an owner and a scope, but it left the platform deciding more
than it should inside an org: a plugin with scope `all` (全部组织启用) cannot be turned off by any
org, and an extension's config is split into two unrelated forms. The deployment form is invisible
to orgs, the org form has its own schema, and nothing lets an org take the platform's values as a
starting point and change them.

The concrete case is model providers (design B). The platform installs Alibaba Bailian with one
key for everyone. One org has its own Bailian account and wants its own key and workspace; another
wants to keep the platform's key. Today neither is possible: model providers are deployment-wide,
and an org can neither change their config nor turn them off.

## 2. Principle (decided)

This is an architecture rule for every extension point, not a model-specific one.

- **The platform (super admin)** decides whether a capability exists and what its defaults are:
  install, permission confirmation, enabling on the platform, default config, which fields an org
  may see or change, and the confirmation of anything shared between orgs.
- **The org admin** is the primary controller of everything inside the org, within what the
  platform offers: it can turn off an extension or plugin the platform enabled for every org, turn
  off a single tool, and override the config fields the extension lets orgs override.

## 3. Goals, non-goals, anti-goals

Goals:

1. Scope `all` is on by default in every org and an org admin may turn it off; built-in plugins stay
   forced on (§4).
2. One config form per extension with a level per field: platform only (hidden or read-only for
   orgs), overridable by orgs, or org only (§5).
3. An org that never edits follows the platform; the first edit copies the overridable fields whole;
   the org can compare its copy with the platform and take platform values back, or drop its copy
   (§5.4, §5.5).
4. The kernel hands each org-bound call the org's effective config (§6), so an extension honours
   org overrides without knowing about copies.
5. An org admin can turn off a single tool of an extension that is on in the org (§7).

Non-goals:

- Sharing between orgs beyond PCM phase 3 (可共享 and super admin association). A adds nothing to it
  **(decided)**.
- Per-org versions of a plugin or extension (PCM ruling F2 stays: one version per deployment).
- Model-specific features: which models an org may use, kinds, embeddings. They are design B; B
  uses §5 and §6 of this design for org keys.
- Changing the trust model: an extension still runs in-process with full trust; levels are
  governance, not isolation. An extension can always read its platform config.

Anti-goals (would make this a failure even if it works):

- An existing extension changing behaviour, or an org seeing a platform value it cannot see today,
  without the extension's author opting in.
- An org admin unable to tell whether a value on its form is the platform's or its own.
- A platform secret reaching an org: shown in a form, a diff or an API response, or sent by the
  extension to an endpoint the org chose.
- A capability on in an org without anyone having chosen that (PCM anti-goal, kept): `all` is the
  super admin's choice, and turning it off is the org admin's.

## 4. Scope `all`: on by default, orgs may turn it off (amends PCM §5)

| Scope | UI | Meaning (new) |
|---|---|---|
| `all` | 全部组织启用 | On in every org, existing and future, **unless an org admin turned it off** |
| `optional` | 组织自选 | Unchanged: off by default, each org admin turns it on |
| `named` | 指定组织 | Unchanged: on by default in the listed orgs, which may turn it off |

Rules:

1. **(decided)** The org switch of an `all` plugin or component works like that of a `named` one in
   a listed org: on unless the org turned it off. Only **built-in** plugins (bootstrap `required`)
   stay locked on, as do their components and extension (`extension.required` stays).
2. **(decided)** This amends PCM §5's `all` row and PCM §13.5's "except components whose scope is
   `all`": an org admin can switch off any component of a plugin that is on in the org, except those
   of built-in plugins.
3. An org that turned an `all` item off stays off when the super admin changes the scope away from
   `all` and back **(designer's call)**: the org's choice is kept in the switch row, as for `named`.
   A new org starts with everything `all` on.
4. Turning an `all` item off follows PCM §5 rule 8 for that org (the confirmation lists the org's
   agents that use it; at run time the item is absent).
5. Dependencies (PCM §5 rule 9) are unchanged: turning a plugin on turns on what it needs; turning
   off a dependency that an on plugin needs is refused with the dependents listed
   **(designer's call**, as today for `named`).
6. Kernel today: `itemLocked = builtin || scope all` (`extensions/plugin-items.ts:50`), `switchPlan`'s
   `locked` (`extensions/org-config.ts:305-317`, 409 `plugin.scope_locked`), `setSwitch` /
   `uninstall` refusals (`catalog/org-catalog.service.ts:491-497,531-539`), `componentLocked`
   (`catalog/component-state.ts:96-100`), and the web's `platform = required || scope === "all"`
   (`apps/web/src/app/(app)/extensions/view.tsx`, `PluginSwitch`, `ComponentSwitch`). All of them
   change to "built-in only". The scope sync (`catalog/scope-sync.ts`) must stop re-enabling an `all`
   item in an org whose switch row says off; today it writes no switch row because nothing could turn
   `all` off.
7. UI: the org's 插件 / 扩展 / 技能 / 智能体模板 rows of an `all` item show 平台默认启用 with a normal
   switch; built-in items keep 已启用 · 平台统一 with no switch. The admin console's scope column
   shows how many orgs turned an `all` item off ("全部组织 · 2 个组织已关闭") **(designer's call)**.

## 5. Two-level extension config

### 5.1 One form, a level per field (decided)

Each extension has one config form. Every field has one of four levels:

| Level | Platform | Org | Example |
|---|---|---|---|
| Platform only, hidden | sets it | does not see it | sandbox-docker's Docker host, object-store-s3's bucket |
| Platform only, read-only | sets it | sees the value, cannot change it | a limit the org should know about |
| Overridable | sets the default | follows the platform until it edits; an edit copies (§5.4) | openai-compatible's endpoint, key and model list |
| Org only | does not set it | each org sets its own | lark's directory app (`LarkOrgConfig`) |

**Defaults keep today's behaviour (decided):** a field of the deployment schema without a level is
platform only, hidden (today orgs never see deployment config); every field of the org schema is
org only (today's org config). An extension shows a two-level form only when its author marks a
deployment field read-only or overridable.

### 5.2 Declaring levels (SDK; designer's call)

- The two schemas stay: `defineExtension({ config: { deployment, org } })` and
  `plugin.json` `extension.configSchemas: { deployment, org }`. They cannot be merged into one object
  because the same name can mean different things at the two levels (lark's `appId` is the
  platform's login app in `deployment` and the org's directory app in `org`).
- A deployment field gets its level from a schema meta, like `secret()` and `hot`: a helper
  `orgAccess(schema, "readonly" | "override")` sets meta `org`, emitted as `x-org` in the JSON
  Schema by `configJsonSchema` (`plugin-sdk/src/config-ui.ts`). No meta = hidden. `x-org` is
  allowed on top-level properties of the deployment schema only (**designer's call:** a level per
  nested field makes the copy and the diff hard to show; an author who needs finer control splits
  the object). `validateConfigUi` rejects `x-org` elsewhere.
- A secret field may be `override` (an org's own key) or hidden. A secret marked `readonly` is
  rejected: the value can never be shown, so read-only would only say "configured", which the form
  shows anyway (§5.6).
- The packer copies `x-org` into `plugin.json` with the rest of the schema; the kernel reads it from
  there (`extensions/config-json-schema.ts`). Older SDKs have no `x-org`, so every older plugin keeps
  today's behaviour.
- **Marking `override` is a promise by the author** that the extension reads that field from the
  config handed to each org-bound call (§6), not from `ctx.config`. The SDK documentation and the
  `writing-extensions` skills say so; nothing checks it statically.
- Changing a field's level in a new plugin version is allowed. A field that stops being `override`
  drops out of every org copy at upgrade (the org then follows the platform for it); a field that
  becomes `override` is not in existing copies, so those orgs follow the platform for it until they
  edit it **(designer's call)**.

### 5.3 Following the platform (decided)

Until an org edits an overridable field, it follows the platform entirely: the org's effective value
of every overridable field is the platform's current value, and platform changes reach the org at
once. The org's form shows the platform's values marked 平台配置 and says that an edit applies to
this org only and does not affect other orgs.

### 5.4 Copy on edit, whole, no sync (decided)

- The first time an org saves a change to any overridable field, the kernel stores a **copy of all
  overridable fields** for that org: the edited values plus the platform's current values of the
  others. Why whole: changing the endpoint usually means the org's own key and model list too, and
  a half-following copy is hard to reason about.
- From then on the copy is the org's own: later platform changes to overridable fields do not reach
  it (a model the platform adds later does not appear). Platform-only fields (hidden and read-only)
  are never in a copy and always follow the platform.
- **Platform secrets never enter a copy (decided):** the secret fields of a copy start empty and the
  org enters its own values. Why: once a copy exists the org controls the other overridable fields
  (an endpoint, a base URL), and a platform key that stayed effective in the copy, copied or
  following, would be sent wherever the org points it, which hands the platform's key to the org.
  The first save that creates a copy must therefore be valid on its own: if a required secret field
  is empty in it, the save is refused with the field named (the form asks for the org's key in the
  same save; the org never lands in `needs_config` by editing). The cost, accepted: an org that only
  wants to change a non-secret field must bring its own key.
- Org-only fields are stored as today (`extension_org_configs.config` and org secrets); they are not
  part of the copy and are unaffected by following, diff or reset.
- Choosing which models an org uses (design B §5.3) is **not** a config edit and never makes a copy
  **(decided)**.
- Validation: an org copy is validated against the deployment schema merged with the platform-only
  values. A copy that becomes invalid (a plugin upgrade changed the schema, a platform-only value
  changed so that the merge fails) makes the extension `needs_config` in that org, like an invalid
  org config today; it never fails the kernel or other orgs.

### 5.4a The platform may leave overridable fields empty (decided)

The super admin may leave a required overridable field empty, so that each org brings its own value
(the case: Bailian installed without a platform key, every org enters its own).

- The load gate changes: today an extension whose deployment config is missing or invalid is not
  loaded on any replica (`extensions/host.ts:1572`). The platform config is now validated with the
  overridable fields optional; only platform-only fields (hidden and read-only) must be complete for
  the extension to load. `ctx.config` then lacks those fields, which the author accepted by marking
  them `override` (§5.2).
- An org that follows the platform while a required overridable field is empty on the platform is
  `needs_config` for that extension (its org page asks it to configure; the effective config is not
  valid, so the kernel does not call the extension for that org). An org with a valid copy works.
- The admin console shows such an extension as 运行中 · 组织需各自配置 with the number of orgs still
  needing config **(designer's call)**, not as an error.
- Design B's provider resolution uses this: a provider whose effective config for the org is invalid
  offers no models in that org.

### 5.5 Compare, take, and go back (decided)

- **Compare**: an org with a copy sees, per overridable non-secret field, its value and the
  platform's current value, with differing fields marked. Secret fields show only whether each side
  is configured (平台已配置 / 本组织已配置); they are never compared, since 相同 / 不同 would let an
  org test guesses of the platform's key **(designer's call)**.
- **Take**: the org picks non-secret fields and takes the platform's current values for them into
  its copy. Secrets cannot be taken (§5.4). The copy stays a copy; taking every field does not turn
  following back on.
- **Use platform config** (使用平台配置): one action, after a confirmation saying the org's own
  values (keys included) will be deleted, drops the copy. The org follows the platform again, and
  later platform changes reach it. There is no separate 清空 action **(designer's call:** two
  buttons with the same effect make people hesitate).

### 5.6 Forms

- **Org form** (`OrgExtensionSheet`, the shared `config-form` renderer): one form. Read-only fields
  are shown disabled, labelled 平台配置. Overridable fields show the effective value; while
  following, a 跟随平台 badge on the form and 平台配置 on each field; with a copy, a banner
  本组织使用自己的配置 with 与平台对比 and 使用平台配置. Org-only fields as today. A secret shows
  平台已配置 / 本组织已配置 / 未配置, never a value. The first edit while following says, before
  saving, that the org's own configuration will need its own keys, and puts the empty secret
  fields in the same save (§5.4). Hidden fields are not sent to the org at all
  (the org API omits them, not only the web).
- **Platform form** (`ExtensionDeploymentConfig`): unchanged fields, plus a small level tag per
  field (组织不可见 / 组织只读 / 组织可覆盖), so the super admin knows what orgs see.
- Members keep seeing no config (PCM ruling P2-13).

### 5.7 What the platform sees (designer's call)

The admin extension detail lists the orgs that have a copy, with when it was made and which
overridable non-secret fields differ from the platform (secrets as configured or not). The super
admin cannot edit
or drop an org's copy (the org admin is the controller inside its org); a deployment disable or a
scope change still applies.

### 5.8 Storage and precedence

- The startup sources keep their precedence for the platform value (env > file / Nacos > PG >
  default); a startup-fixed field stays read-only on the platform form and can still be overridden
  by an org if the author marked it `override` **(designer's call:** the startup config pins the
  platform default, not what orgs may do).
- The org copy needs its own storage next to `extension_org_configs` (a nullable column or table:
  builder's call), with its secrets in `capybara.secrets` under the org, in a key namespace distinct
  from today's org-only `plugin-config:<plugin>:<path>`. "No copy" must be distinguishable from "a
  copy equal to the platform".
- Writes are org-audited (`extension.org_config_copied`, `..._taken`, `..._reset`: names are the
  builder's), run in `@Transactional` methods, and invalidate cached effective config after the
  commit. No in-process state; every replica resolves the effective config from PG and Redis
  (AGENTS.md multi-replica rules).
- Disabling or uninstalling an extension keeps the copies, like org config today.

## 6. Delivering the effective config

`ctx.config` stays what it is: the platform's deployment config, for setup and for work not done on
behalf of an org. There is no `ctx` accessor for org config today, and A adds none
**(designer's call:** an accessor would let extensions read any org's config outside a call made for
that org).

The **effective config** of an extension for an org = the platform's deployment config with the
org's copy applied to the overridable fields (or no change while following). The kernel computes it
per call (cached per org and extension, invalidated after writes) and passes it, together with the
org-only config as today, in **every call it makes on behalf of an org**, that is every SDK callback
whose arguments carry an `orgId` **(designer's call:** otherwise an extension's panel could show
the platform's values while its tools use the org's, and authors could not work around it without a
`ctx` accessor). Known today:

- web-search@1 / web-fetch@1 and directory@1, which already receive `orgConfig` per call
  (`extensions/point-defaults.ts`, `orgs/directory-sync.ts`), also receive `config` (effective);
- extension tools: the tool call context;
- extension UI: `ctx.ui` view and action handlers (`plugin-sdk/src/ui.ts`) and file-preview
  `render` (`file-preview.ts`);
- hooks whose payload carries an org (`hooks.ts`);
- extension HTTP routes called in an org's context;
- model-provider@2: becomes org-bound in design B (its calls carry the org and the effective config;
  B §5.5).

The builder lists the full set from the SDK. Points that are deployment-wide today (sandbox@1,
object-store@1, channel@1 with its connection config, identity-source@1, connector@1) carry no org;
`override` has no effect on them until a later design makes them org-bound. `capybara-plugin check`
warns when an extension marks `override` but provides only such points and has no org-bound callback
(tools, UI, hooks, routes) **(designer's call)**.

The effective config of an org with a copy never contains a platform secret (§5.4); while
following, it contains the platform's values, secrets included, exactly as `ctx.config` does today.

**Org-owned extensions (PCM phase 3; designer's call):** the platform layer of an extension an org
uploaded is still the super admin's deployment config. The extension runs for the whole deployment
and its deployment config is platform governance; the uploading org is one org among others here,
following the platform or keeping a copy.

The exact parameter names and whether old points get `config` additively are the builder's, within
the SDK API rules (snapshot and changeset bumping `@capybara-hq/plugin-sdk`).

## 7. Per-org tool switch (decided)

- An org admin can turn off a single tool of an extension that is on in the org. The tool is then
  absent in that org: not in any agent's tool list at run time, shown as unavailable in the agent
  editor, refused if called. Replays record this through the existing `tools_changed` drift.
- Scope: tools registered by extensions (`ctx.tools.register`, keys `plugin__<extension>__<tool>`).
  Builtin tools and connector tools are out: connector tools already have their own per-connector
  status (`connector_tools.status`), and the sandbox tools have `sandboxToolPolicy`
  **(designer's call)**.
- Turning a tool off follows PCM §5 rule 8 (the confirmation lists the org's agents that selected
  it). An agent selecting the extension's tools as `all` simply lacks the switched-off tool. An agent
  created from a template (PCM §15) that names a switched-off tool gets it marked unavailable, like
  any tool the org cannot use **(designer's call)**.
- Stored per (org, extension, tool name) (builder names the table). A tool the extension stops
  registering keeps its row harmlessly; the row applies again if the tool comes back.
- UI: the org's 扩展 detail lists the extension's tools with a switch each, for org admins; members
  see the list read-only.
- The platform cannot turn off a single tool for every org in this design (it can disable the
  extension). **(designer's call:** not asked for; a platform tool switch can come later with the
  same table keyed by a platform row.)

## 8. Model providers and connectors (decided)

Model provider extensions and connector extensions follow the same rules as every other extension:
an org can turn off one whose scope is `all`, `named` or `optional` (§4), and use its own config
where the author marked fields `override` (§5). `openai-compatible` is built-in, so orgs cannot turn
it off, but can override its fields once the plugin marks them. What this means for model calls
(org-bound provider calls, org model choice) is design B. Connectors themselves are already per org
(endpoint, credentials, tool status); connector extensions have only the deployment field
`allowInsecureLoopback`, which stays hidden.

## 9. Current state the builder starts from (`main` at `76b32e10`, 2026-11-07)

- Config declaration: `define-extension.ts:29` (`config: { deployment?, org? }`), `secret()` meta
  (`secret.ts`), `hot` meta, `ui()` hints and `configJsonSchema` emitting `x-secret` / `x-hot` /
  `x-ui` (`config-ui.ts:126,157-189`), `validateConfigUi(schema, level)` (`config-ui.ts:380`), packer
  `pack/config-schemas.ts`.
- Platform config: `extension_deployment_configs` (non-secret fields), secrets under org
  `_deployment` key `plugin-deployment-config:<plugin>:<path>`; merge and precedence in
  `deployment-config-store.ts:97-118`; read-only startup fields 409 `extension.config_readonly`.
  Saving reloads the instance or calls `updateConfig` for hot fields (`host.ts:2090-2175`).
- Org config: `extension_org_configs(plugin, org_id, enabled, config)`, secrets key
  `plugin-config:<plugin>:<path>`, read per call by `OrgExtensionConfigs.get`
  (`org-config.ts:524-591`). No fallback to deployment config anywhere.
- Enabled set: `extension_org_configs.enabled` ∪ `extension_installs.required`
  (`extensions/enabled.ts`); scope `catalog/scope.ts`; switches `catalog_item_org_switches`,
  `component_org_switches`.
- Tools: per-agent selection (`AgentToolRef`) and `toolPolicies`; no org tool switch.
- Web: `apps/web/src/components/config-form/` (`ConfigForm.tsx`, adapters `deployment.ts`,
  `org.ts`, `channel.ts`), `ExtensionDeploymentConfig.tsx`, `OrgExtensionSheet.tsx`.

## 10. Constraints

- Multi-replica: effective config, switches and tool switches live in PG (plus Redis caches
  invalidated after commit); no in-process state.
- Migrations are expand-only (`writing-migrations`).
- Replay: no model-visible change for existing conversations; a tool switched off shows up as
  `tools_changed` as tool changes do today.
- Web: design templates and components only, query keys and freshness rules, i18n zh and en
  (`writing-web-ui`, `check:web-ui`, `check:i18n`).
- SDK: API snapshot and a changeset bumping `@capybara-hq/plugin-sdk` (`check:sdk-api`,
  `check:sdk-api-changeset`).
- Docs: AGENTS.md "Config" and "two-level config" in `writing-extensions` (core and
  `capybara-hq/plugins`) describe the levels, copies and the effective config.

## 11. Open

None. Decided in the review round (2026-11-07): the platform may leave overridable fields empty
(§5.4a); platform secrets never enter a copy (§5.4).

## 12. Left to the builder

Table and column names; the API routes and shapes (org form with levels, copy, diff, take, reset,
tool switches); the effective-config cache; the exact SDK helper name and parameter names of §6;
the migration of `all` items' locked state; empty and loading states.
